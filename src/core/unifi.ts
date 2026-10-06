// Reads a UniFi OS gateway (UDR/UDM) through the same local API its web page uses:
// log in with a local account, then read the Network application's stats. Read-only.
import https from 'https';
import type { GatewayNetwork, GatewayPort, GatewayStats } from './types';

const agent = new https.Agent({ rejectUnauthorized: false, keepAlive: true, maxSockets: 4 });

export class UniFiError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'network' | 'api' = 'api',
  ) {
    super(message);
  }
}

interface Raw {
  health: unknown[];
  devices: unknown[];
  networks: unknown[];
  clients: unknown[];
}

export class UniFiClient {
  private cookie = '';
  private csrf = '';

  constructor(
    private host: string,
    private user: string,
    private pass: string,
    private timeoutMs = 10000,
  ) {}

  private request(method: string, path: string, body?: unknown): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }> {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : undefined;
      const req = https.request(
        {
          host: this.host,
          port: 443,
          path,
          method,
          agent,
          timeout: this.timeoutMs,
          headers: {
            Accept: 'application/json',
            ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
            ...(this.cookie ? { Cookie: this.cookie } : {}),
            ...(this.csrf ? { 'X-CSRF-Token': this.csrf } : {}),
          },
        },
        (res) => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (text += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
        },
      );
      req.on('timeout', () => req.destroy(new UniFiError(`${this.host} did not answer in time`, 'network')));
      req.on('error', (e: NodeJS.ErrnoException) => {
        if (e instanceof UniFiError) return reject(e);
        if (e.code === 'ECONNREFUSED') return reject(new UniFiError(`${this.host} refused the connection on port 443. Its web interface may be blocked from this network: allow Office to the gateway on 443 in the firewall.`, 'network'));
        if (e.code === 'ETIMEDOUT' || e.code === 'EHOSTUNREACH' || e.code === 'ECONNRESET') return reject(new UniFiError(`Can't reach ${this.host} on port 443 (${e.code}). A firewall rule may be blocking the web interface from this network.`, 'network'));
        reject(new UniFiError(`${this.host}: ${e.message}`, 'network'));
      });
      if (data) req.write(data);
      req.end();
    });
  }

  async login() {
    this.cookie = '';
    this.csrf = '';
    const r = await this.request('POST', '/api/auth/login', { username: this.user, password: this.pass, remember: true });
    if (r.status === 401 || r.status === 403) {
      throw new UniFiError('The gateway rejected the login. Use a local UniFi account (not your ui.com login) without two-step verification.', 'auth');
    }
    if (r.status === 429) throw new UniFiError('The gateway is rate limiting logins. Wait a few minutes.', 'auth');
    if (r.status !== 200) throw new UniFiError(`Login failed (HTTP ${r.status}). Is this a UniFi OS gateway?`, 'api');
    const set = r.headers['set-cookie'];
    const cookies = (Array.isArray(set) ? set : set ? [set] : []).map((c) => c.split(';')[0]);
    this.cookie = cookies.join('; ');
    const csrf = r.headers['x-csrf-token'] ?? r.headers['x-updated-csrf-token'];
    this.csrf = Array.isArray(csrf) ? csrf[0] : (csrf ?? '');
    if (!this.cookie) throw new UniFiError('Logged in but the gateway gave no session cookie.', 'api');
  }

  private async get(path: string, retry = true): Promise<unknown[]> {
    if (!this.cookie) await this.login();
    const r = await this.request('GET', `/proxy/network/api/s/default/${path}`);
    if ((r.status === 401 || r.status === 403) && retry) {
      await this.login();
      return this.get(path, false);
    }
    if (r.status !== 200) throw new UniFiError(`${path}: HTTP ${r.status}`, r.status === 401 ? 'auth' : 'api');
    let j: { data?: unknown[]; meta?: { rc?: string; msg?: string } };
    try {
      j = JSON.parse(r.text);
    } catch {
      throw new UniFiError(`${path}: not JSON`, 'api');
    }
    if (j.meta?.rc && j.meta.rc !== 'ok') throw new UniFiError(`${path}: ${j.meta.msg ?? j.meta.rc}`, 'api');
    return Array.isArray(j.data) ? j.data : [];
  }

  async raw(): Promise<Raw> {
    const health = await this.get('stat/health'); // first call does the login
    const [devices, networks, clients] = await Promise.all([this.get('stat/device'), this.get('rest/networkconf'), this.get('stat/sta')]);
    return { health, devices, networks, clients };
  }
}

// ---------------------------------------------------------------------------------------------
// Pure parsing (unit tested)

type O = Record<string, unknown>;
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const isGateway = (d: O) => ['udm', 'ugw', 'uxg'].includes(str(d.type)) || !!d.wan1;

/** Port byte counters, keyed by port_idx (WAN is -1), for working out rates between readings. */
export type Counters = { t: number; ports: Record<number, { rx: number; tx: number }> };

export function gatewayDevice(devices: unknown[]): O | null {
  const list = devices as O[];
  return list.find(isGateway) ?? null;
}

export function readCounters(dev: O, t: number): Counters {
  const ports: Counters['ports'] = {};
  for (const p of (dev.port_table as O[] | undefined) ?? []) {
    const idx = num(p.port_idx);
    const rx = num(p.rx_bytes);
    const tx = num(p.tx_bytes);
    if (idx !== null && rx !== null && tx !== null) ports[idx] = { rx, tx };
  }
  const w = dev.wan1 as O | undefined;
  if (w && num(w.rx_bytes) !== null && num(w.tx_bytes) !== null) ports[-1] = { rx: num(w.rx_bytes)!, tx: num(w.tx_bytes)! };
  return { t, ports };
}

/** Mbps from two counter readings; null if a counter went backwards (reboot) or no time passed. */
export function rate(prev: Counters | undefined, cur: Counters, idx: number, dir: 'rx' | 'tx'): number | null {
  const a = prev?.ports[idx];
  const b = cur.ports[idx];
  if (!a || !b || !prev) return null;
  const dt = (cur.t - prev.t) / 1000;
  const d = b[dir] - a[dir];
  if (dt <= 0 || d < 0) return null;
  return Math.round(((d * 8) / dt / 1e6) * 100) / 100;
}

function poolSize(start: string, stop: string): number | null {
  const n = (ip: string) => ip.split('.').reduce((a, b) => a * 256 + (parseInt(b, 10) || 0), 0);
  if (!start || !stop) return null;
  const size = n(stop) - n(start) + 1;
  return size > 0 && size < 65536 ? size : null;
}

export function parseStats(raw: Raw, prev: Counters | undefined, cur: Counters): GatewayStats {
  const dev = gatewayDevice(raw.devices) ?? {};
  const health = raw.health as O[];
  const www = health.find((h) => h.subsystem === 'www') ?? {};
  const wan = health.find((h) => h.subsystem === 'wan') ?? {};
  const sys = (dev['system-stats'] as O | undefined) ?? {};

  const ports: GatewayPort[] = ((dev.port_table as O[] | undefined) ?? [])
    .map((p) => {
      const idx = num(p.port_idx) ?? -99;
      const fallback = (k: string) => {
        const v = num(p[k]);
        return v === null ? null : Math.round(((v * 8) / 1e6) * 100) / 100;
      };
      return {
        idx,
        name: str(p.name) || `Port ${idx}`,
        up: p.up === true,
        speed: num(p.speed),
        txMbps: rate(prev, cur, idx, 'tx') ?? (prev ? null : fallback('tx_bytes-r')),
        rxMbps: rate(prev, cur, idx, 'rx') ?? (prev ? null : fallback('rx_bytes-r')),
      };
    })
    .filter((p) => p.idx !== -99)
    .sort((a, b) => a.idx - b.idx);

  const clientsBy = new Map<string, number>();
  for (const c of raw.clients as O[]) {
    const k = str(c.network_id) || str(c.network);
    clientsBy.set(k, (clientsBy.get(k) ?? 0) + 1);
  }
  const networks: GatewayNetwork[] = (raw.networks as O[])
    .filter((n) => str(n.purpose) !== 'wan' && (str(n.ip_subnet) || n.dhcpd_enabled !== undefined))
    .map((n) => ({
      name: str(n.name),
      subnet: str(n.ip_subnet),
      clients: (clientsBy.get(str(n._id)) ?? 0) + (clientsBy.get(str(n.name)) ?? 0),
      poolSize: n.dhcpd_enabled ? poolSize(str(n.dhcpd_start), str(n.dhcpd_stop)) : null,
      leaseSeconds: num(n.dhcpd_leasetime),
    }));

  // WAN throughput: our own counter rate when we have one, else the gateway's rate fields
  const wanDown = rate(prev, cur, -1, 'rx') ?? num(wan['rx_bytes-r']);
  const wanUp = rate(prev, cur, -1, 'tx') ?? num(wan['tx_bytes-r']);
  const toMbps = (v: number | null, already: boolean) => (v === null ? null : already ? v : Math.round(((v * 8) / 1e6) * 100) / 100);
  return {
    name: str(dev.name) || str(dev.hostname),
    model: str(dev.model),
    uptime: num(dev.uptime),
    cpu: num(sys.cpu),
    mem: num(sys.mem),
    wanLatency: num(www.latency),
    wanUp: www.status ? www.status === 'ok' : null,
    wanDownMbps: toMbps(wanDown, rate(prev, cur, -1, 'rx') !== null),
    wanUpMbps: toMbps(wanUp, rate(prev, cur, -1, 'tx') !== null),
    ports,
    networks,
  };
}

/** The port that feeds the radios: the one chosen in Settings, else one named after Lookout/Monks. */
export function pickWatchPort(ports: GatewayPort[], chosen: number | null): GatewayPort | null {
  if (chosen !== null) return ports.find((p) => p.idx === chosen) ?? null;
  return ports.find((p) => /lookout|monks/i.test(p.name)) ?? null;
}
