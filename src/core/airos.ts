import https from 'https';
import http from 'http';
import crypto from 'crypto';
import type { RadioStatus, Station } from './types';

/**
 * Minimal client for the airOS 6.x web UI (NanoStation / NanoBeam M-series).
 *
 * Flow, as the browser does it:
 *   1. GET /login.cgi, which sets the radio's AIROS_* session cookie
 *   2. POST /login.cgi (urlencoded: username, password, uri) -> 302 on success
 *   3. GET /index.cgi to activate the session
 *   4. GET /status.cgi and /sta.cgi -> JSON
 * HTTPS is tried first; a radio with its secure web server switched off is reached over HTTP.
 * Radios use self-signed certificates, so certificate checks are off for these hosts only.
 */

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface SpeedTestResult {
  ok: boolean;
  /** Mbps, from the testing radio to the target */
  tx: number | null;
  /** Mbps, from the target back to the testing radio */
  rx: number | null;
  message: string;
  seconds?: number;
}

const round2 = (n: unknown) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 100) / 100 : null);

class SchemeSwitch extends Error {}

export class AirOSError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'network' | 'parse') {
    super(message);
  }
}

export class AirOSClient {
  private cookies = new Map<string, string>();
  private loggedIn = false;
  /** step-by-step record of the last login, shown in errors so failures explain themselves */
  private trace: string[] = [];
  /** false once we've found this radio only answers plain HTTP */
  private secure = true;

  constructor(
    readonly ip: string,
    private username: string,
    private password: string,
    private timeoutMs = 8000,
    private port = 443,
  ) {}

  private cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  private get origin() {
    return this.secure ? (this.port === 443 ? `https://${this.ip}` : `https://${this.ip}:${this.port}`) : `http://${this.ip}`;
  }

  private request(method: string, path: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const mod = this.secure ? https : http;
      const req = mod.request(
        {
          host: this.ip,
          port: this.secure ? this.port : 80,
          path,
          method,
          ...(this.secure ? { agent } : {}),
          timeout: this.timeoutMs,
          headers: {
            Cookie: this.cookieHeader(),
            'User-Agent': 'ParkWiFiMonitor',
            Accept: '*/*',
            ...(body ? { 'Content-Length': String(body.length) } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const sc = res.headers['set-cookie'];
            for (const c of sc ?? []) {
              const [pair] = c.split(';');
              const i = pair.indexOf('=');
              if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
          });
        },
      );
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', (e) => reject(new AirOSError(`${this.ip}: ${e.message}`, 'network')));
      if (body) req.write(body);
      req.end();
    });
  }

  async login(): Promise<void> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.loginOnce();
      } catch (e) {
        // A radio with HTTPS switched off can answer on 443 with a redirect to http://. Switch and retry once.
        if (e instanceof SchemeSwitch && attempt === 0) continue;
        throw e;
      }
    }
  }

  private async loginOnce(): Promise<void> {
    // 1. The radio hands out its own session cookie (AIROS_SESSIONID or AIROS_<mac>) on the login page.
    this.cookies.clear();
    this.trace = [];
    let g: Resp;
    try {
      g = await this.request('GET', '/login.cgi');
    } catch (e) {
      if (!this.secure) throw e;
      // HTTPS refused: try plain HTTP before giving up
      this.secure = false;
      try {
        g = await this.request('GET', '/login.cgi');
      } catch {
        this.secure = true;
        throw e;
      }
    }
    this.trace.push(`${this.secure ? 'https' : 'http'} GET /login.cgi ${g.status}${g.headers.location ? ' -> ' + g.headers.location : ''} cookies[${[...this.cookies.keys()].join(',') || 'none'}]`);
    this.checkSchemeSwitch(g);
    if (![...this.cookies.keys()].some((k) => k.startsWith('AIROS'))) {
      // older builds expect the browser to make one up
      this.cookies.set('AIROS_SESSIONID', crypto.randomBytes(16).toString('hex'));
    }

    // 2. Post the form exactly as the browser does; success is a 302 redirect.
    const origin = this.origin;
    const form = new URLSearchParams({ username: this.username, password: this.password, uri: '/index.cgi' }).toString();
    const r = await this.request('POST', '/login.cgi', Buffer.from(form, 'utf8'), {
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: origin,
      Referer: `${origin}/login.cgi`,
    });
    this.trace.push(`POST /login.cgi ${r.status}${r.headers.location ? ' -> ' + r.headers.location : ''}`);
    this.checkSchemeSwitch(r);
    if (r.status !== 302 && r.status !== 303) {
      throw new AirOSError(`${this.ip}: login rejected (check username/password). Steps: ${this.trace.join('; ')}`, 'auth');
    }
    const loc = String(r.headers.location ?? '');
    if (/login\.cgi/i.test(loc)) {
      throw new AirOSError(`${this.ip}: login rejected (check username/password). Steps: ${this.trace.join('; ')}`, 'auth');
    }

    // 3. airOS 6 only activates the session once the landing page has been loaded.
    const act = await this.request('GET', '/index.cgi', undefined, { Referer: `${origin}/login.cgi` });
    this.trace.push(`GET /index.cgi ${act.status}${act.headers.location ? ' -> ' + act.headers.location : ''}`);
    if ((act.status === 302 || act.status === 303) && /login\.cgi/i.test(String(act.headers.location ?? ''))) {
      throw new AirOSError(`${this.ip}: session was not activated after login. Steps: ${this.trace.join('; ')}`, 'auth');
    }
    this.loggedIn = true;
  }

  /** If an HTTPS request is redirected to plain http://, the radio's secure web server is off. */
  private checkSchemeSwitch(r: Resp) {
    const loc = String(r.headers.location ?? '');
    if (this.secure && /^http:\/\//i.test(loc)) {
      this.secure = false;
      throw new SchemeSwitch();
    }
    if (!this.secure && /^https:\/\//i.test(loc)) {
      this.secure = true;
      throw new SchemeSwitch();
    }
  }

  private async getJSON<T>(path: string, retry = true, headers: Record<string, string> = {}): Promise<T> {
    if (!this.loggedIn) await this.login();
    const r = await this.request('GET', path, undefined, headers);
    const text = r.body.trim();
    const looksJson = text.startsWith('{') || text.startsWith('[');
    if (r.status === 302 || r.status === 401 || r.status === 403 || !looksJson) {
      if (retry) {
        this.loggedIn = false;
        return this.getJSON<T>(path, false, headers);
      }
      throw new AirOSError(`${this.ip}: not logged in after retry (HTTP ${r.status} on ${path}). Login steps: ${this.trace.join('; ')}`, 'auth');
    }
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new AirOSError(`${this.ip}: bad JSON from ${path}`, 'parse');
    }
  }

  /**
   * airOS's built-in Network Speed Test, driven the way its sptest.js does it:
   *   action=remote (log the test into the target radio) -> action=start -> poll action=status
   *   until state 10 (finished). flags 0 = good result; any other flag = the test failed.
   *   Final tx/rx are Mbps from this radio's point of view (tx = this radio to the target).
   * The target radio is logged into over plain HTTP on `port`, which is why it fails when the
   * target only serves HTTPS.
   */
  async speedTest(opts: { target: string; port: number; user: string; pass: string; duration: number; direction: 'dx' | 'tx' | 'rx' }): Promise<SpeedTestResult> {
    if (!this.loggedIn) await this.login();
    const ticket = Math.floor(Math.random() * 1000);
    const sid = [...this.cookies.entries()].find(([k]) => k.startsWith('AIROS'))?.[1] ?? '';
    const hdr = { Referer: `${this.origin}/sptest.cgi`, 'X-Requested-With': 'XMLHttpRequest' };
    const q = (o: Record<string, string | number>) =>
      '/sptest_action.cgi?' + new URLSearchParams({ ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)])), _: String(Date.now()) }).toString();
    type R = { status: number; message?: string; state?: number; flags?: number; tx?: number; rx?: number };
    const base = { ticket, target: opts.target, port: opts.port, login: opts.user, passwd: opts.pass };
    const started = Date.now();
    try {
      const rem = await this.getJSON<R>(q({ ...base, action: 'remote', airosid: sid }), true, hdr);
      if (rem.status !== 0) return { ok: false, tx: null, rx: null, message: `Couldn't reach the target: ${rem.message ?? 'error'}` };
      const st = await this.getJSON<R>(q({ ...base, action: 'start', duration: opts.duration, direction: opts.direction }), true, hdr);
      if (st.status !== 0) return { ok: false, tx: null, rx: null, message: `Test didn't start: ${st.message ?? 'error'}` };
      const deadline = Date.now() + (opts.duration + 20) * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const s = await this.getJSON<R>(q({ ticket, action: 'status' }), true, hdr);
        if (s.state === 10) {
          if (s.flags === 0) return { ok: true, tx: round2(s.tx), rx: round2(s.rx), message: 'Completed', seconds: Math.round((Date.now() - started) / 1000) };
          return {
            ok: false,
            tx: null,
            rx: null,
            message:
              `The target radio didn't run the test (flags ${s.flags}). Usually the target's web server is HTTPS-only: ` +
              `the test logs into it over plain HTTP on port ${opts.port}.`,
          };
        }
      }
      return { ok: false, tx: null, rx: null, message: 'Speed test timed out' };
    } finally {
      await this.getJSON(q({ ticket, action: 'stop' }), false, hdr).catch(() => undefined);
    }
  }

  async status(): Promise<{ raw: unknown; parsed: RadioStatus }> {
    const raw = await this.getJSON<Record<string, unknown>>('/status.cgi');
    return { raw, parsed: parseStatus(raw) };
  }

  async stations(): Promise<{ raw: unknown; parsed: Station[] }> {
    const raw = await this.getJSON<unknown>('/sta.cgi');
    return { raw, parsed: parseStations(raw) };
  }

  /** Cheap check used by discovery: does this host serve an airOS login page? */
  static async probe(ip: string, timeoutMs = 2500): Promise<boolean> {
    const c = new AirOSClient(ip, '', '', timeoutMs);
    try {
      const r = await c.request('GET', '/login.cgi');
      return r.status > 0 && (/airos|ubnt|ubiquiti/i.test(r.body) || c.cookies.size > 0);
    } catch {
      return false;
    }
  }
}

// ---------- parsing (defensive: airOS 6 builds differ in field names and units) ----------

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));

/** CCQ is reported in tenths of a percent by status.cgi (991 = 99.1%) and as % by sta.cgi on some builds. */
export function pct(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return n > 100 ? Math.round(n) / 10 : n;
}

export function parseStatus(raw: Obj): RadioStatus {
  const host = obj(raw.host);
  const w = obj(raw.wireless);
  const polling = obj(w.polling);
  const airmax = obj(w.airmax);
  const ifaces = Array.isArray(raw.interfaces) ? (raw.interfaces as Obj[]) : [];
  const eth = ifaces.find((i) => str(i.ifname) === 'eth0');

  const total = num(host.totalram);
  const free = num(host.freeram);
  const memPct = total && free !== null ? Math.round(((total - free) / total) * 100) : num(host.mem ?? host.memory);
  let cpu = num(host.cpuload);
  if (cpu === null) {
    const load = Array.isArray(host.loadavg) ? num((host.loadavg as unknown[])[0]) : num(host.loadavg);
    cpu = load !== null ? Math.round(load * 100) : null;
  }

  return {
    hostname: str(host.hostname),
    model: str(host.devmodel ?? host.model),
    firmware: str(host.fwversion),
    uptime: num(host.uptime),
    mode: str(w.mode).toLowerCase(),
    wds: w.wds === true || w.wds === 1 || w.wds === '1' || /wds/i.test(str(w.mode)),
    essid: str(w.essid),
    frequency: num(w.frequency),
    channel: num(w.channel),
    channelWidth: num(w.chwidth ?? w.chanbw),
    signal: num(w.signal),
    noise: num(w.noisef ?? w.noise),
    ccq: pct(w.ccq),
    txRate: num(w.txrate),
    rxRate: num(w.rxrate),
    txPower: num(w.txpower),
    airmaxQuality: num(polling.quality ?? airmax.quality),
    airmaxCapacity: num(polling.capacity ?? airmax.capacity),
    stationCount: num(w.count),
    cpu,
    memPct,
    lanSpeed: eth ? num(obj(eth.status).speed) : null,
    security: str(w.security),
  };
}

export function parseStations(raw: unknown): Station[] {
  if (!Array.isArray(raw)) return [];
  return (raw as Obj[]).map((s) => ({
    mac: str(s.mac).toUpperCase(),
    name: str(s.name),
    ip: str(s.lastip) || '',
    signal: num(s.signal),
    noise: num(s.noisefloor ?? s.noise),
    ccq: pct(s.ccq),
    txRate: num(s.tx),
    rxRate: num(s.rx),
    latency: num(s.txlatency ?? s.latency),
    uptime: num(s.uptime),
    distanceM: num(s.distance),
  }));
}
