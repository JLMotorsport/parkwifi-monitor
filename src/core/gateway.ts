// Polls one UniFi gateway every 15 seconds so short bursts on the radio-feeding port are caught,
// then hands the monitor one sample per main poll: last readings plus the minute's average and peak.
import { UniFiClient, UniFiError, parseStats, pickWatchPort, readCounters, gatewayDevice, type Counters } from './unifi';
import type { GatewayCfg, GatewayStats, Sample } from './types';

const FAST_MS = 15_000;
const AUTH_BACKOFF_MS = 10 * 60_000;
const NET_BACKOFF_MS = 60_000;

export class GatewayPoller {
  latest: GatewayStats | null = null;
  error = '';
  errorAt = 0;
  private client: UniFiClient | null = null;
  private key = '';
  private prev: Counters | undefined;
  private window: { down: number; up: number }[] = [];
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
    const w = pickWatchPort(stats.ports, this.cfg.watchPort);
    if (w && w.txMbps !== null && w.rxMbps !== null) this.window.push({ down: w.txMbps, up: w.rxMbps });
    this.latest = stats;
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
    }
    this.window = [];
    return { t, id: 'gw:' + this.cfg.id, ping: { sent: 0, received: 0, lossPct: 0, avg: null, min: null, max: null }, gw: stats };
  }
}
