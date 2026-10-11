// Blocks or unblocks a device on one or every access point. Each AP goes through the same steps:
// read its ACL and check the radio can undo by itself, refuse anything risky, write the change with
// a 5-minute undo timer on the radio, then check the AP came back, the device is gone and the other
// devices reconnected. Only then is the timer cancelled; otherwise the change is undone.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { blockedMacs, MAC_RE, parseAcl, planBlock, planUnblock } from './acl';
import { AclSsh, type AirOSSsh } from './airos-ssh';
import type { AclState, BlockJob, BlockStep, BlockedDevice, Station } from './types';

export interface BlockHost {
  aps(): { id: string; name: string; ip: string }[];
  ssh(ip: string): AirOSSsh;
  /** a fresh read of an AP's connected devices; null if it didn't answer */
  stations(apId: string): Promise<Station[] | null>;
  /** devices on the AP at the last poll */
  liveCount(apId: string): number | null;
  label(mac: string): string;
  changed(): void;
  log(msg: string): void;
}

export const UNDO_SECONDS = 300;

export interface Timing {
  settleMs: number;
  verifyEveryMs: number;
  verifyTries: number;
  selftestWaitMs: number;
}
const DEFAULT_TIMING: Timing = { settleMs: 40_000, verifyEveryMs: 15_000, verifyTries: 4, selftestWaitMs: 5000 };

/** Devices left after a block: at least 60% of the others, as in a change test. */
export const enoughBack = (before: number | null, after: number) => before === null || after >= Math.floor(Math.max(0, before - 1) * 0.6);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(items: T[], limit: number, fn: (t: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}

export class BlockManager {
  state: AclState = { job: null, jobs: [], blocked: [], notes: [], refreshedAt: null, refreshing: false };
  private logFile: string;

  constructor(
    dataDir: string,
    private host: BlockHost,
    private timing: Timing = DEFAULT_TIMING,
  ) {
    this.logFile = path.join(dataDir, 'blocks.jsonl');
    try {
      this.state.jobs = fs
        .readFileSync(this.logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as BlockJob)
        .reverse()
        .slice(0, 20);
    } catch {
      /* none yet */
    }
  }

  get busy() {
    return !!this.state.job && !this.state.job.endedAt;
  }

  /** Start blocking (or unblocking) a MAC on the given APs, or every AP. Returns at once. */
  start(kind: 'block' | 'unblock', macIn: string, apIds?: string[]): BlockJob {
    const mac = macIn.toUpperCase();
    if (!MAC_RE.test(mac)) throw new Error(`${macIn} is not a MAC address.`);
    if (this.busy) throw new Error('Already blocking or unblocking a device. One at a time.');
    const all = this.host.aps();
    const aps = apIds?.length ? all.filter((a) => apIds.includes(a.id)) : all;
    if (!aps.length) throw new Error('No access points to change.');
    const job: BlockJob = {
      id: crypto.randomBytes(5).toString('hex'),
      kind,
      mac,
      label: this.host.label(mac),
      startedAt: Date.now(),
      steps: aps.map((a) => ({ apId: a.id, apName: a.name, state: 'waiting', message: 'Waiting' })),
    };
    this.state.job = job;
    this.host.changed();
    void this.run(job, aps).catch((e) => this.host.log(`block job ${job.id} crashed: ${(e as Error).message}`));
    return job;
  }

  private async run(job: BlockJob, aps: { id: string; name: string; ip: string }[]) {
    await pool(aps, 4, async (ap) => {
      const step = job.steps.find((s) => s.apId === ap.id)!;
      try {
        await this.one(job, ap, step);
      } catch (e) {
        this.set(step, 'failed', `Stopped: ${(e as Error).message}`);
      }
    });
    job.endedAt = Date.now();
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(job) + '\n');
    } catch {
      /* best effort */
    }
    this.state.jobs.unshift(job);
    this.state.jobs = this.state.jobs.slice(0, 20);
    this.host.log(`${job.kind} ${job.mac}: ${job.steps.map((s) => `${s.apName} ${s.state}`).join(', ')}`);
    this.host.changed();
    void this.refresh();
  }

  private set(step: BlockStep, state: BlockStep['state'], message: string) {
    step.state = state;
    step.message = message;
    this.host.changed();
  }

  private async one(job: BlockJob, ap: { id: string; name: string; ip: string }, step: BlockStep) {
    const acl = new AclSsh(this.host.ssh(ap.ip), this.timing.selftestWaitMs);
    this.set(step, 'checking', 'Reading its MAC ACL and checking it can undo by itself…');
    const read = await acl.read(true);
    if (read.pending) return this.set(step, 'skipped', 'A change is being tested on this AP right now. Try again when it finishes.');
    if (!read.canApply) return this.set(step, 'failed', `Nothing changed. ${read.problems.join(' ')}`);
    const current = parseAcl(read.text);
    const plan = job.kind === 'block' ? planBlock(current, job.mac) : planUnblock(current, job.mac);
    if (plan.kind === 'refuse') return this.set(step, 'skipped', `Nothing changed. ${plan.reason}`);
    if (plan.kind === 'nothing') return this.set(step, 'done', plan.reason);

    const before = this.host.liveCount(ap.id);
    const token = crypto.randomBytes(8).toString('hex');
    this.set(step, 'applying', `Writing it (${plan.describe}). Its devices drop for a few seconds.`);
    await acl.apply(plan.edits, plan.check, UNDO_SECONDS, token);

    this.set(step, 'verifying', 'Checking the AP came back and its devices reconnected…');
    await sleep(this.timing.settleMs);
    let last: Station[] | null = null;
    for (let i = 0; i < this.timing.verifyTries; i++) {
      last = await this.host.stations(ap.id).catch(() => null);
      const others = last?.filter((s) => s.mac.toUpperCase() !== job.mac).length ?? 0;
      const stillThere = !!last?.some((s) => s.mac.toUpperCase() === job.mac);
      if (last && (job.kind === 'unblock' || (!stillThere && enoughBack(before, others)))) break;
      if (i < this.timing.verifyTries - 1) await sleep(this.timing.verifyEveryMs);
    }
    const why =
      last === null
        ? 'the AP stopped answering'
        : job.kind === 'block' && last.some((s) => s.mac.toUpperCase() === job.mac)
          ? 'the device was still connected, so the block did not take'
          : job.kind === 'block' && !enoughBack(before, last.filter((s) => s.mac.toUpperCase() !== job.mac).length)
            ? `only ${last.filter((s) => s.mac.toUpperCase() !== job.mac).length} of its other ${Math.max(0, (before ?? 1) - 1)} devices came back`
            : null;
    if (why) {
      try {
        await acl.undo(plan.undo);
        return this.set(step, 'undone', `Undone: ${why}.`);
      } catch (e) {
        return this.set(step, 'undone', `Undoing: ${why}. The app couldn't reach it (${(e as Error).message}); the radio's own timer puts it back within ${UNDO_SECONDS / 60} minutes.`);
      }
    }
    try {
      await acl.confirm(token);
    } catch (e) {
      return this.set(step, 'undone', `Every check passed, but ${(e as Error).message}`);
    }
    this.set(step, 'done', job.kind === 'block' ? `Blocked. ${last!.length} device${last!.length === 1 ? '' : 's'} still connected.` : 'Unblocked.');
  }

  /** Read every AP's ACL (read-only) to list what is blocked where, including blocks made by hand. */
  async refresh() {
    if (this.state.refreshing) return;
    this.state.refreshing = true;
    this.host.changed();
    const by = new Map<string, BlockedDevice>();
    const notes: AclState['notes'] = [];
    await pool(this.host.aps(), 6, async (ap) => {
      try {
        const r = await new AclSsh(this.host.ssh(ap.ip)).read(false);
        const acl = parseAcl(r.text);
        if (acl.on && acl.policy !== 'deny') notes.push({ apId: ap.id, apName: ap.name, note: 'Uses an allow list, so the app will not block or unblock here.' });
        else if (!acl.on && acl.entries.length) notes.push({ apId: ap.id, apName: ap.name, note: `Has ${acl.entries.length} old ACL entries with the ACL off; the app will not change it.` });
        for (const mac of blockedMacs(acl)) {
          const d = by.get(mac) ?? { mac, label: this.host.label(mac), aps: [] };
          d.aps.push({ apId: ap.id, apName: ap.name });
          by.set(mac, d);
        }
      } catch (e) {
        notes.push({ apId: ap.id, apName: ap.name, note: `Couldn't read it: ${(e as Error).message}` });
      }
    });
    this.state.blocked = [...by.values()].sort((a, b) => a.mac.localeCompare(b.mac));
    this.state.notes = notes.sort((a, b) => a.apName.localeCompare(b.apName));
    this.state.refreshedAt = Date.now();
    this.state.refreshing = false;
    this.host.changed();
  }
}
