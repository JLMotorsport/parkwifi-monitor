// Changes access-point settings over SSH, the way airOS's own "Test" button works but with the
// safety net on the radio itself: before applying, the radio is given a timer that restores the
// previous settings unless the app confirms. If the app, the PC or the network goes away mid-test,
// the radio still puts itself back.
import { Client, type ConnectConfig } from 'ssh2';
import type { RadioChange } from './types';

export const CFG = '/tmp/system.cfg';
export const BACKUP = '/tmp/pwm-backup.cfg';
export const PENDING = '/tmp/pwm-pending';
export const SOFTRESTART = '/usr/etc/rc.d/rc.softrestart';
export const SELFTEST = '/tmp/pwm-selftest';

/**
 * Run `body` in the background so it outlives the SSH session. airOS's BusyBox has no nohup, so
 * this uses a subshell that ignores hangup with its input and output detached, which any sh can do.
 */
export const bg = (body: string) => `( trap '' HUP INT TERM; ${body} ) </dev/null >/dev/null 2>&1 &`;

/** system.cfg keys the app may write, and the range each value must fall in. */
const KEYS = {
  txPower: { key: 'radio.1.txpower', ok: (v: number) => Number.isInteger(v) && v >= 1 && v <= 30 },
  frequency: { key: 'radio.1.freq', ok: (v: number) => Number.isInteger(v) && v >= 2412 && v <= 2472 && (v - 2407) % 5 === 0 },
} as const;

export interface Preflight {
  ok: boolean;
  problems: string[];
  values: Record<string, string>;
  pendingFromEarlier: boolean;
}

export class SshError extends Error {}

export class AirOSSsh {
  constructor(
    private host: string,
    private user: string,
    private pass: string,
    private port = 22,
    private timeoutMs = 20000,
    private selftestWaitMs = 5000,
  ) {}

  /** Run one command and return stdout. Rejects on connect/auth failure or timeout. */
  run(cmd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const conn = new Client();
      let out = '';
      let done = false;
      const finish = (err: Error | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        conn.end();
        if (err) reject(err);
        else resolve(out);
      };
      const timer = setTimeout(() => finish(new SshError(`SSH to ${this.host} timed out`)), this.timeoutMs);
      conn
        .on('keyboard-interactive', (_n, _i, _l, prompts, reply) => reply(prompts.map(() => this.pass)))
        .on('ready', () => {
          conn.exec(cmd, (err, stream) => {
            if (err) return finish(err);
            stream
              .on('data', (d: Buffer) => (out += d.toString()))
              .on('close', () => finish(null));
            stream.stderr.on('data', () => undefined);
          });
        })
        .on('error', (e) => finish(new SshError(sshMessage(e, this.host, this.port))))
        .on('close', () => finish(null));
      const cfg: ConnectConfig = {
        host: this.host,
        port: this.port,
        username: this.user,
        password: this.pass,
        tryKeyboard: true,
        readyTimeout: this.timeoutMs,
        hostVerifier: () => true,
        // airOS 6 runs an old Dropbear: allow the older algorithms it offers
        algorithms: {
          kex: { append: ['diffie-hellman-group14-sha1', 'diffie-hellman-group1-sha1'] } as never,
          serverHostKey: { append: ['ssh-rsa', 'ssh-dss'] } as never,
          cipher: { append: ['aes128-cbc', 'aes256-cbc', '3des-cbc'] } as never,
          hmac: { append: ['hmac-sha1', 'hmac-md5'] } as never,
        },
      };
      conn.connect(cfg);
    });
  }

  /** Read-only: confirm the radio has everything the change path relies on. */
  async preflight(change: RadioChange): Promise<Preflight> {
    const keys = Object.keys(change).map((k) => KEYS[k as keyof typeof KEYS].key);
    const out = await this.run(
      `grep -E '^(${keys.map((k) => k.replace(/\./g, '\\.')).join('|')})=' ${CFG}; ` +
        `[ -x ${SOFTRESTART} ] && echo '@SOFTRESTART'; [ -f ${PENDING} ] && echo '@PENDING'; rm -f ${SELFTEST}; ` +
        `${bg(`sleep 3; echo ok > ${SELFTEST}`)} echo '@END'`,
    );
    // prove a background job outlives the session on this radio: the undo timer depends on it
    await new Promise((r) => setTimeout(r, this.selftestWaitMs));
    const st = await this.run(`cat ${SELFTEST} 2>/dev/null; rm -f ${SELFTEST}`);
    const values: Record<string, string> = {};
    for (const line of out.split('\n')) {
      const m = line.match(/^([a-z0-9.]+)=(.*)$/i);
      if (m) values[m[1]] = m[2].trim();
    }
    const problems: string[] = [];
    if (!out.includes('@END')) problems.push('The radio did not run the check command.');
    for (const k of keys) if (!(k in values)) problems.push(`${k} is not in ${CFG}, so this firmware stores the setting differently.`);
    if (!out.includes('@SOFTRESTART')) problems.push(`${SOFTRESTART} is missing, so the radio can't apply settings this way.`);
    if (!st.includes('ok')) problems.push('A test timer started on the radio did not survive the SSH session closing, so the on-radio undo would not run.');
    return { ok: problems.length === 0, problems, values, pendingFromEarlier: out.includes('@PENDING') };
  }

  /**
   * Apply a change for `seconds`, after which the radio restores its backup unless confirm()
   * has been called. Returns once the change is written; the radio restarts its wireless
   * a second later in the background.
   */
  async applyTrial(change: RadioChange, seconds: number, token: string): Promise<void> {
    if (!/^[a-f0-9]{8,32}$/.test(token)) throw new SshError('bad token');
    const secs = Math.round(seconds);
    if (secs < 60 || secs > 3600) throw new SshError('trial must be 1 to 60 minutes');
    const edits = this.edits(change);
    const undo = `if [ "$(cat ${PENDING} 2>/dev/null)" = "${token}" ]; then cp ${BACKUP} ${CFG} && rm -f ${PENDING} && ${SOFTRESTART} save; fi`;
    const script = [
      'set -e',
      `cp ${CFG} ${BACKUP}`,
      ...edits,
      `echo ${token} > ${PENDING}`,
      bg(`sleep ${secs}; ${undo}`),
      bg(`sleep 1; ${SOFTRESTART} save`),
      `echo @APPLIED`,
    ].join('\n');
    const out = await this.run(script);
    if (!out.includes('@APPLIED')) throw new SshError('The radio did not accept the change (nothing was applied).');
  }

  /** Keep the change: cancel the radio's undo timer. Settings were already saved by the trial. */
  async confirm(token: string): Promise<void> {
    const out = await this.run(`if [ "$(cat ${PENDING} 2>/dev/null)" = "${token}" ]; then rm -f ${PENDING}; echo @KEPT; else echo @GONE; fi`);
    if (!out.includes('@KEPT')) throw new SshError('The radio had already undone the change (its timer ran out first).');
  }

  /**
   * Put the previous values back now. Writes them explicitly rather than copying the backup, so
   * it still works if the radio rebooted mid-test and lost its /tmp files.
   */
  async restore(before: RadioChange): Promise<void> {
    const edits = this.edits(before);
    const out = await this.run(
      ['set -e', `rm -f ${PENDING}`, ...edits, bg(`sleep 1; ${SOFTRESTART} save`), 'echo @RESTORED'].join('\n'),
    );
    if (!out.includes('@RESTORED')) throw new SshError('The radio did not accept the old settings.');
  }

  private edits(change: RadioChange): string[] {
    const edits: string[] = [];
    for (const [k, v] of Object.entries(change)) {
      const spec = KEYS[k as keyof typeof KEYS];
      if (!spec || typeof v !== 'number' || !spec.ok(v)) throw new SshError(`refusing ${k}=${v}`);
      const re = spec.key.replace(/\./g, '\\.');
      edits.push(`sed -i 's/^${re}=.*/${spec.key}=${v}/' ${CFG}`, `grep -q '^${re}=${v}$' ${CFG}`);
    }
    if (!edits.length) throw new SshError('nothing to change');
    return edits;
  }
}

function sshMessage(e: Error & { level?: string; code?: string }, host: string, port: number) {
  if (e.level === 'client-authentication') return `SSH login to ${host} was refused (wrong password, or SSH logins are off on the radio)`;
  if (e.code === 'ECONNREFUSED') return `${host} refused SSH on port ${port}. Turn on SSH Server under the radio's Services tab.`;
  if (e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH') return `Can't reach ${host} on port ${port}`;
  return `SSH to ${host}: ${e.message}`;
}
