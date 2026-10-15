// Polls one UniFi gateway every 15 seconds so short bursts on the radio-feeding port are caught,
// then hands the monitor one sample per main poll: last readings plus the minute's average and peak.
import { UniFiClient, UniFiError, parseStats, pickWatchPort, readCounters, gatewayDevice, type Counters } from './unifi';
import { clientBytes, clientRates, dpiDelta, parseDpi, summariseMinute, type ClientBytes, type ClientRate, type Reading } from './usage';
import type { GatewayCfg, GatewayStats, Sample } from './types';

const FAST_MS = 15_000;
const AUTH_BACKOFF_MS = 10 * 60_000;
const NET_BACKOFF_MS = 60_000;
/** Read traffic identification every fourth reading (once a minute); it is a heavier request. */
const DPI_EVERY = 4;

/** Name, maker and address for each device UDR3 knows, keyed by upper-case MAC. */
export function clientInfo(list: unknown[]): Map<string, { name: string; vendor: string; ip: string }> {
  const m = new Map<string, { name: string; vendor: string; ip: string }>();
  for (const c of list as Record<string, unknown>[]) {
    const mac = typeof c.mac === 'string' ? c.mac.toUpperCase() : '';
    if (!mac) continue;
    const s = (v: unknown) => (typeof v === 'string' ? v : '');
    m.set(mac, { name: s(c.name) || s(c.hostname), vendor: s(c.oui), ip: s(c.ip) || s(c.last_ip) });
  }
  return m;
}

export class GatewayPoller {
  latest: GatewayStats | null = null;
  /** UDR3's own list of devices: name and maker by MAC (upper case), for naming flood sources */
  clients = new Map<string, { name: string; vendor: string; ip: string }>();
  error = '';
  errorAt = 0;
  private client: UniFiClient | null = null;
  private key = '';
  private prev: Counters | undefined;
  private window: { down: number; up: number; flood: number | null; fromGw: number | null }[] = [];
  private usage: Reading[] = [];
  private prevBytes: { t: number; m: Map<string, ClientBytes> } | undefined;
  private dpiSnap: Map<string, Map<number, number>> | undefined;
  private dpiRecent = new Map<string, { t: number; apps: { cat: string; mb: number }[] }>();
  private dpiOk: boolean | undefined;
  private ticks = 0;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    public cfg: GatewayCfg,
    private password: () => string,
    private onChange: () => void,
  ) {}

  start() {
    this.stop();
    this.timer = setTimeout(() => void this.tick(), 1000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private ready() {
    return this.cfg.enabled && !!this.cfg.host && !!this.cfg.username && !!this.password();
  }

  private conn() {
    const k = `${this.cfg.host}|${this.cfg.username}|${this.password()}`;
    if (!this.client || k !== this.key) {
      this.client = new UniFiClient(this.cfg.host, this.cfg.username, this.password());
      this.key = k;
      this.prev = undefined;
      this.prevBytes = undefined;
      this.dpiSnap = undefined;
    }
    return this.client;
  }

  private async tick() {
    let wait = FAST_MS;
    if (this.ready() && !this.busy) {
      this.busy = true;
      try {
        await this.read();
        this.error = '';
      } catch (e) {
        const err = e as UniFiError;
        this.error = err.message;
        this.errorAt = Date.now();
        wait = err.kind === 'auth' ? AUTH_BACKOFF_MS : NET_BACKOFF_MS;
        if (err.kind === 'auth') this.client = null;
        this.onChange();
      } finally {
        this.busy = false;
      }
    }
    this.timer = setTimeout(() => void this.tick(), wait);
  }

  private async read() {
    const raw = await this.conn().raw();
    const dev = gatewayDevice(raw.devices);
    if (!dev) throw new UniFiError('Logged in, but no gateway was listed in the Network application.', 'api');
    const cur = readCounters(dev, Date.now());
    const stats = parseStats(raw, this.prev, cur);
    this.prev = cur;
    this.clients = clientInfo(raw.clients);
    // who is using the connection: each device's speed since the last reading
    const now = Date.now();
    const bytes = clientBytes(raw.clients, raw.networks);
    const rates: ClientRate[] = this.prevBytes ? clientRates(this.prevBytes.m, bytes, (now - this.prevBytes.t) / 1000) : [];
    this.prevBytes = { t: now, m: bytes };
    if (rates.length || stats.wanDownMbps != null) {
      const sum = rates.reduce((a, r) => a + r.downMbps, 0);
      this.usage.push({ t: now, totalDown: stats.wanDownMbps ?? Math.round(sum * 100) / 100, rates: rates.slice(0, 8) });
    }
    if (this.ticks++ % DPI_EVERY === 0) await this.readDpi(now);
    const w = pickWatchPort(stats.ports, this.cfg.watchPort);
    if (w && w.txMbps !== null && w.rxMbps !== null) {
      const f = w.txFloodPps != null || w.rxFloodPps != null ? (w.txFloodPps ?? 0) + (w.rxFloodPps ?? 0) : null;
      this.window.push({ down: w.txMbps, up: w.rxMbps, flood: f, fromGw: w.txFloodPps ?? null });
    }
    this.latest = stats;
  }

  /** What kind of traffic each device moved since the last DPI reading. Optional: failures are ignored. */
  private async readDpi(now: number) {
    try {
      const cur = parseDpi(await this.conn().post('stat/stadpi', { type: 'by_app' }));
      if (this.dpiSnap) {
        for (const [mac, cats] of cur) {
          const apps = dpiDelta(this.dpiSnap.get(mac), cats);
          if (apps.length) this.dpiRecent.set(mac, { t: now, apps: apps.slice(0, 3) });
        }
      }
      this.dpiSnap = cur;
      this.dpiOk = cur.size > 0;
      for (const [mac, v] of this.dpiRecent) if (now - v.t > 5 * 60_000) this.dpiRecent.delete(mac);
    } catch {
      this.dpiOk = false;
    }
  }

  /** One-off login and read, for the Test button in Settings. */
  async test(): Promise<{ ok: boolean; message: string; ports: { idx: number; name: string; up: boolean }[] }> {
    try {
      const c = new UniFiClient(this.cfg.host, this.cfg.username, this.password());
      const raw = await c.raw();
      const dev = gatewayDevice(raw.devices);
      if (!dev) return { ok: false, message: 'Logged in, but no gateway was listed.', ports: [] };
      const s = parseStats(raw, undefined, readCounters(dev, Date.now()));
      const w = pickWatchPort(s.ports, this.cfg.watchPort);
      return {
        ok: true,
        message: `Connected to ${s.name || s.model || this.cfg.host}. ${s.ports.length} ports, ${s.networks.length} networks.${w ? ` Watching "${w.name}".` : ' Pick the port that feeds the radios.'}`,
        ports: s.ports.map((p) => ({ idx: p.idx, name: p.name, up: p.up })),
      };
    } catch (e) {
      return { ok: false, message: (e as Error).message, ports: [] };
    }
  }

  /** Called once per main poll: a history sample with the minute's average and peak. */
  flush(t: number): Sample | null {
    if (!this.latest) return null;
    const stats: GatewayStats = { ...this.latest };
    const w = pickWatchPort(stats.ports, this.cfg.watchPort);
    if (w && this.window.length) {
      const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100;
      stats.watch = {
        idx: w.idx,
        name: w.name,
        downMbps: avg(this.window.map((x) => x.down)),
        upMbps: avg(this.window.map((x) => x.up)),
        downPeak: Math.max(...this.window.map((x) => x.down)),
        upPeak: Math.max(...this.window.map((x) => x.up)),
        readings: this.window.length,
      };
      const fl = this.window.map((x) => x.flood).filter((x): x is number => x !== null);
      const fg = this.window.map((x) => x.fromGw).filter((x): x is number => x !== null);
      if (fl.length) {
        stats.watch.floodPps = Math.round(fl.reduce((a, b) => a + b, 0) / fl.length);
        stats.watch.floodPeakPps = Math.max(...fl);
        stats.watch.floodFromGatewayPps = fg.length ? Math.round(fg.reduce((a, b) => a + b, 0) / fg.length) : null;
      }
    }
    this.window = [];
    const m = summariseMinute(this.usage);
    const withApps = <T extends { mac: string; apps?: { cat: string; mb: number }[] }>(c: T): T => {
      const d = this.dpiRecent.get(c.mac);
      return d && t - d.t < 2 * 60_000 ? { ...c, apps: d.apps } : c;
    };
    stats.top = m.top.map(withApps);
    stats.peak = m.peak ? { ...m.peak, clients: m.peak.clients.map(withApps) } : null;
    stats.dpiOk = this.dpiOk;
    this.usage = [];
    return { t, id: 'gw:' + this.cfg.id, ping: { sent: 0, received: 0, lossPct: 0, avg: null, min: null, max: null }, gw: stats };
  }
}
