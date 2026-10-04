import https from 'https';
import crypto from 'crypto';
import type { RadioStatus, Station } from './types';

/**
 * Minimal client for the airOS 6.x web UI (NanoStation / NanoBeam M-series).
 *
 * Flow, as the browser does it:
 *   1. pick a random 32-hex AIROS_SESSIONID cookie (the login page's JS does this)
 *   2. GET /login.cgi with that cookie, collect anything the radio sets
 *   3. POST /login.cgi (multipart: uri, username, password) -> 302 on success
 *   4. GET /status.cgi and /sta.cgi -> JSON
 * Radios use self-signed certificates, so certificate checks are off for these hosts only.
 */

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: false });

interface Resp {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export class AirOSError extends Error {
  constructor(message: string, readonly kind: 'auth' | 'network' | 'parse') {
    super(message);
  }
}

export class AirOSClient {
  private cookies = new Map<string, string>();
  private loggedIn = false;

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

  private request(method: string, path: string, body?: Buffer, headers: Record<string, string> = {}): Promise<Resp> {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          host: this.ip,
          port: this.port,
          path,
          method,
          agent,
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
    this.cookies.clear();
    this.cookies.set('AIROS_SESSIONID', crypto.randomBytes(16).toString('hex'));
    await this.request('GET', '/login.cgi');

    const boundary = '----pwm' + crypto.randomBytes(8).toString('hex');
    const field = (n: string, v: string) =>
      `--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`;
    const body = Buffer.from(
      field('uri', '/index.cgi') + field('username', this.username) + field('password', this.password) + `--${boundary}--\r\n`,
      'utf8',
    );
    const r = await this.request('POST', '/login.cgi', body, {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    });
    // Success is a redirect; a failed login re-serves the login form with a 200.
    if (r.status === 200 && /name=["']?password/i.test(r.body)) {
      throw new AirOSError(`${this.ip}: login rejected (check username/password)`, 'auth');
    }
    this.loggedIn = true;
  }

  private async getJSON<T>(path: string, retry = true): Promise<T> {
    if (!this.loggedIn) await this.login();
    const r = await this.request('GET', path);
    const text = r.body.trim();
    const looksJson = text.startsWith('{') || text.startsWith('[');
    if (r.status === 302 || r.status === 401 || r.status === 403 || !looksJson) {
      if (retry) {
        this.loggedIn = false;
        return this.getJSON<T>(path, false);
      }
      throw new AirOSError(`${this.ip}: not logged in after retry (HTTP ${r.status})`, 'auth');
    }
    try {
      return JSON.parse(text) as T;
    } catch (e) {
      throw new AirOSError(`${this.ip}: bad JSON from ${path}`, 'parse');
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
