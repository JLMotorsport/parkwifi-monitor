// Runs one access-point change at a time as a timed trial: measure before, apply with the radio's
// own undo timer armed, measure again, then keep it only if nothing got worse. Anything unexpected
// ends in an undo; if the app can't reach the radio to undo, the radio's timer does it.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { AirOSSsh } from './airos-ssh';
import type { ChangeTrial, RadioChange, Sample, Suggestion, Thresholds, TrialCheck, TrialStats } from './types';

/** What the trial manager needs from the monitor (kept narrow so it can be tested alone). */
export interface TrialHost {
  suggestions(): Suggestion[];
  device(id: string): { ip: string; name: string; isAp: boolean } | null;
  history(id: string, hours: number): Sample[];
  sample(id: string): Promise<Sample | null>;
  ssh(ip: string): Pick<AirOSSsh, 'preflight' | 'applyTrial' | 'confirm' | 'restore'>;
  trialMinutes(): number;
  thresholds(): Thresholds;
  changed(): void;
  log(msg: string): void;
}

const SETTLE_MS = 45_000;
const SAMPLE_MS = 30_000;
/** The radio waits this much longer than the app before undoing on its own. */
const RADIO_MARGIN_S = 180;

export function stats(rows: Sample[]): TrialStats {
  const mean = (xs: (number | null | undefined)[]) => {
    const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
  };
  const withRadio = [...rows].reverse().find((r) => r.radio);
  return {
    samples: rows.length,
    reachablePct: rows.length ? Math.round((rows.filter((r) => r.ping.received > 0 && r.radio).length / rows.length) * 100) : 0,
    pingAvg: mean(rows.map((r) => r.ping.avg)),
    lossAvg: mean(rows.map((r) => r.ping.lossPct)),
    clients: mean(rows.map((r) => r.stations?.count)),
    noise: mean(rows.map((r) => r.radio?.noise)),
    // an AP with nobody on reports CCQ 0, which says nothing about the channel
    ccq: mean(rows.map((r) => ((r.stations?.count ?? 0) > 0 && (r.radio?.ccq ?? 0) > 0 ? r.radio!.ccq : null))),
    txPower: withRadio?.radio?.txPower ?? null,
    frequency: withRadio?.radio?.frequency ?? null,
  };
}

/** Pure decision: keep the change only when every check passes. */
export function evaluate(change: RadioChange, base: TrialStats, after: TrialStats): TrialCheck[] {
  const checks: TrialCheck[] = [];
  if (change.txPower != null)
    checks.push({
      name: 'New power in use',
      ok: after.txPower != null && Math.abs(after.txPower - change.txPower) <= 1,
      detail: `radio reports ${after.txPower ?? 'nothing'} dBm, asked for ${change.txPower}`,
    });
  if (change.frequency != null)
    checks.push({
      name: 'New channel in use',
      ok: after.frequency === change.frequency,
      detail: `radio reports ${after.frequency ?? 'nothing'} MHz, asked for ${change.frequency}`,
    });
  checks.push({ name: 'Stayed online', ok: after.samples >= 2 && after.reachablePct >= 80, detail: `answered ${after.reachablePct}% of ${after.samples} checks` });
  if (base.clients != null && base.clients >= 1) {
    const floor = Math.floor(base.clients * 0.6);
    checks.push({
      name: 'Devices came back',
      ok: (after.clients ?? 0) >= floor,
      detail: `${after.clients ?? 0} connected on average, was ${base.clients} (needs at least ${floor})`,
    });
  }
  if (base.pingAvg != null)
    checks.push({
      name: 'Ping no worse',
      ok: after.pingAvg != null && after.pingAvg <= base.pingAvg * 1.5 + 10,
      detail: `${after.pingAvg ?? '?'} ms, was ${base.pingAvg} ms`,
    });
  if (base.lossAvg != null)
    checks.push({ name: 'Loss no worse', ok: after.lossAvg != null && after.lossAvg <= base.lossAvg + 5, detail: `${after.lossAvg ?? '?'}%, was ${base.lossAvg}%` });
  if (change.frequency != null && base.noise != null)
    checks.push({
      name: 'Channel no noisier',
      ok: after.noise != null && after.noise <= base.noise + 2,
      detail: `noise ${after.noise ?? '?'} dBm, was ${base.noise} dBm${after.noise != null && after.noise <= base.noise - 2 ? ' (quieter)' : ''}`,
    });
  if (change.frequency != null && base.ccq != null && after.ccq != null)
    checks.push({
      name: 'Link quality no worse',
      ok: after.ccq >= base.ccq - 5,
      detail: `CCQ ${after.ccq}%, was ${base.ccq}%${after.ccq >= base.ccq + 5 ? ' (better)' : ''}`,
    });
  return checks;
}

export class ChangeManager {
  trial: ChangeTrial | null = null;
  history: ChangeTrial[] = [];
  private token = '';
  private samples: Sample[] = [];
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private file: string;
  private logFile: string;

  constructor(
    dataDir: string,
    private host: TrialHost,
  ) {
    this.file = path.join(dataDir, 'trial.json');
    this.logFile = path.join(dataDir, 'changes.jsonl');
    try {
      this.history = fs
        .readFileSync(this.logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as ChangeTrial)
        .reverse()
        .slice(0, 50);
    } catch {
      /* no changes yet */
    }
  }

  /** After a restart mid-trial: put the old settings back rather than guess. */
  async recover() {
    let t: (ChangeTrial & { token?: string }) | null = null;
    try {
      t = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return;
    }
    if (!t || (t.status !== 'applying' && t.status !== 'testing')) return this.clearFile();
    this.trial = t;
    this.token = t.token ?? '';
    await this.undo('The app closed during the test, so the old settings were put back.');
  }

  async start(suggestionId: string): Promise<ChangeTrial> {
    if (this.trial && (this.trial.status === 'checking' || this.trial.status === 'applying' || this.trial.status === 'testing'))
      throw new Error(`Already testing a change on ${this.trial.deviceName}. One at a time.`);
    const sug = this.host.suggestions().find((s) => s.id === suggestionId);
    if (!sug || !sug.change) throw new Error('That suggestion has no change the app can make (or it no longer applies).');
    const dev = this.host.device(sug.deviceId);
    if (!dev || !dev.isAp) throw new Error('Only access points can be changed from the app.');

    const t: ChangeTrial = {
      id: crypto.randomBytes(6).toString('hex'),
      deviceId: sug.deviceId,
      deviceName: dev.name,
      ip: dev.ip,
      suggestionId,
      title: sug.changeLabel ?? sug.title,
      change: sug.change,
      before: {},
      status: 'checking',
      startedAt: Date.now(),
      checks: [],
      message: 'Checking the radio before changing anything…',
    };
    this.trial = t;
    this.samples = [];
    this.host.changed();
    void this.run(t).catch((e) => this.fail(`Stopped: ${(e as Error).message}. Nothing was changed.`));
    return t;
  }

  private async run(t: ChangeTrial) {
    const base = this.host.history(t.deviceId, 0.5).filter((s) => s.t < t.startedAt);
    if (base.filter((s) => s.radio).length < 3)
      return this.fail('Not enough recent readings of this radio to compare against. Try again after a few polls.');
    t.baseline = stats(base);

    const ssh = this.host.ssh(t.ip);
    const pf = await ssh.preflight(t.change);
    if (pf.pendingFromEarlier) return this.fail('The radio still has an unfinished change from earlier. It will undo itself within a few minutes; try again after that.');
    if (!pf.ok) return this.fail(`Nothing changed. ${pf.problems.join(' ')}`);
    if (t.change.txPower != null) t.before.txPower = Number(pf.values['radio.1.txpower']);
    if (t.change.frequency != null) t.before.frequency = Number(pf.values['radio.1.freq']);
    if (Object.values(t.before).some((v) => !Number.isFinite(v))) return this.fail('Could not read the current setting from the radio. Nothing changed.');
    if (Object.entries(t.change).every(([k, v]) => t.before[k as keyof RadioChange] === v)) return this.fail('The radio is already set that way. Nothing to change.');

    const minutes = this.host.trialMinutes();
    this.token = crypto.randomBytes(8).toString('hex');
    t.status = 'applying';
    t.message = 'Applying. The radio restarts its wireless, so its devices drop for a few seconds.';
    this.persist();
    try {
      await ssh.applyTrial(t.change, minutes * 60 + RADIO_MARGIN_S, this.token);
    } catch (e) {
      return this.undo(`Applying failed (${(e as Error).message}), so the old settings were written back to be safe.`);
    }
    this.host.log(`change ${t.id}: applied ${JSON.stringify(t.change)} to ${t.deviceName} (was ${JSON.stringify(t.before)})`);

    t.status = 'testing';
    const applied = Date.now();
    t.trialEndsAt = applied + minutes * 60_000;
    t.message = `Testing for ${minutes} minutes. It is kept only if nothing gets worse; otherwise it is undone.`;
    this.persist();
    this.loop(applied);
  }

  private loop(applied: number) {
    const tick = async () => {
      const t = this.trial;
      if (!t || t.status !== 'testing' || this.stopping) return;
      const s = await this.host.sample(t.deviceId).catch(() => null);
      if (s && s.t - applied >= SETTLE_MS) this.samples.push(s);
      t.result = stats(this.samples);
      // three missed checks in a row after settling: don't wait out the clock
      const last3 = this.samples.slice(-3);
      if (last3.length === 3 && last3.every((x) => x.ping.received === 0 || !x.radio)) {
        return this.undo('The radio stopped answering after the change, so it was undone.');
      }
      this.host.changed();
      if (Date.now() >= (t.trialEndsAt ?? 0)) return this.finish();
      this.timer = setTimeout(() => void tick(), SAMPLE_MS);
    };
    this.timer = setTimeout(() => void tick(), 15_000);
  }

  private async finish() {
    const t = this.trial;
    if (!t || !t.baseline) return;
    t.result = stats(this.samples);
    t.checks = evaluate(t.change, t.baseline, t.result);
    const bad = t.checks.filter((c) => !c.ok);
    if (bad.length) return this.undo(`Undone: ${bad.map((c) => c.name.toLowerCase()).join(', ')} failed.`);
    try {
      await this.host.ssh(t.ip).confirm(this.token);
      this.end('kept', 'Kept: every check passed.');
    } catch (e) {
      this.end('reverted', `Every check passed, but ${(e as Error).message}`);
    }
  }

  /** Manual "Keep it now" during a test. */
  async keepNow() {
    const t = this.trial;
    if (!t || t.status !== 'testing') throw new Error('No change is being tested.');
    this.stopTimer();
    t.result = stats(this.samples);
    if (t.baseline) t.checks = evaluate(t.change, t.baseline, t.result);
    await this.host.ssh(t.ip).confirm(this.token);
    this.end('kept', 'Kept early by you.');
  }

  /** Manual "Undo now", and every automatic undo. */
  async undo(reason = 'Undone by you.') {
    const t = this.trial;
    if (!t || (t.status !== 'testing' && t.status !== 'applying')) throw new Error('No change is being tested.');
    this.stopTimer();
    try {
      await this.host.ssh(t.ip).restore(t.before);
      this.end('reverted', reason);
    } catch (e) {
      this.end('reverted', `${reason} The app couldn't reach the radio (${(e as Error).message}); the radio's own timer puts the old settings back within ${Math.round(RADIO_MARGIN_S / 60)} minutes of the test ending.`);
    }
  }

  private fail(msg: string) {
    this.end('failed', msg);
  }

  private end(status: ChangeTrial['status'], message: string) {
    const t = this.trial;
    if (!t) return;
    this.stopTimer();
    t.status = status;
    t.message = message;
    t.endedAt = Date.now();
    this.history.unshift({ ...t });
    this.history = this.history.slice(0, 50);
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(t) + '\n');
    } catch {
      /* logging is best effort */
    }
    this.host.log(`change ${t.id}: ${status}: ${message}`);
    this.clearFile();
    this.host.changed();
  }

  private persist() {
    try {
      fs.writeFileSync(this.file, JSON.stringify({ ...this.trial, token: this.token }));
    } catch {
      /* best effort */
    }
    this.host.changed();
  }

  private clearFile() {
    try {
      fs.unlinkSync(this.file);
    } catch {
      /* already gone */
    }
  }

  private stopTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** App shutting down: leave the radio's own timer to undo anything in progress. */
  shutdown() {
    this.stopping = true;
    this.stopTimer();
  }
}

