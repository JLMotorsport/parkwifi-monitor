import { EventEmitter } from 'events';
import { AirOSClient, AirOSError } from './airos';
import { AlertEngine, roleOf } from './alerts';
import { ConfigStore, SecretBox, slug } from './config';
import { ping } from './ping';
import { HistoryStore } from './store';
import type { AlertItem, AppState, DeviceCfg, DeviceState, Sample, Station, UpdateInfo } from './types';

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface MonitorHooks {
  /** Called when an alert is raised (desktop notification in Electron). */
  notify?(a: AlertItem): void;
  update?(): UpdateInfo;
  autostart?(): boolean | null;
}

export class Monitor extends EventEmitter {
  readonly cfg: ConfigStore;
  readonly history: HistoryStore;
  readonly alerts: AlertEngine;
  private clients = new Map<string, AirOSClient>();
  private latest = new Map<string, Sample>();
  private live = new Map<string, Station[]>();
  private raw = new Map<string, { status?: unknown; stations?: unknown; error?: string; t: number }>();
  private events: AlertItem[] = [];
  private timer: NodeJS.Timeout | null = null;
  lastPoll: number | null = null;
  nextPoll: number | null = null;
  polling = false;

  constructor(dataDir: string, box: SecretBox, readonly version: string, public hooks: MonitorHooks = {}) {
    super();
    this.cfg = new ConfigStore(dataDir, box);
    this.history = new HistoryStore(dataDir, this.cfg.config.retentionDays);
    this.events = this.history.recentAlerts(100);
    this.alerts = new AlertEngine({
      raised: (a) => {
        this.history.logAlert(a);
        this.events.unshift(a);
        if (this.cfg.config.notifications) this.hooks.notify?.(a);
      },
      resolved: (a) => {
        this.history.logAlert(a);
        this.events.unshift(a);
      },
      event: (a) => {
        this.history.logAlert(a);
        this.events.unshift(a);
        if (this.cfg.config.notifications) this.hooks.notify?.(a);
      },
    });
    for (const d of this.cfg.config.devices) {
      const prev = this.history.previous(d.id);
      if (prev) this.latest.set(d.id, prev);
    }
  }

  start() {
    this.schedule(2000);
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.nextPoll = Date.now() + ms;
    this.timer = setTimeout(() => void this.pollNow(), ms);
  }

  private client(d: DeviceCfg): AirOSClient {
    const c = this.cfg.config;
    const key = `${d.ip}|${c.username}|${c.passwordEnc}`;
    let cl = this.clients.get(d.id);
    if (!cl || (cl as unknown as { _key?: string })._key !== key) {
      cl = new AirOSClient(d.ip, c.username, this.cfg.password());
      (cl as unknown as { _key?: string })._key = key;
      this.clients.set(d.id, cl);
    }
    return cl;
  }

  async pollNow(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.emit('change');
    const c = this.cfg.config;
    const t = Date.now();
    const samples: Sample[] = [];
    try {
      const devs = c.devices.filter((d) => d.enabled);
      const hasPassword = !!this.cfg.password();
      await pool(devs, 10, async (d) => {
        const [p, radio] = await Promise.all([
          ping(d.ip, c.pingCount, c.pingSize),
          hasPassword ? this.readRadio(d) : Promise.resolve({ error: 'No password set', kind: 'auth' as const }),
        ]);
        const s: Sample = { t, id: d.id, ping: p };
        if ('status' in radio && radio.status) {
          s.radio = radio.status;
          const st = radio.stations ?? [];
          const sig = st.map((x) => x.signal).filter((x): x is number => x !== null);
          s.stations = {
            count: st.length,
            weak: sig.filter((x) => x <= c.thresholds.weakSignal).length,
            avgSignal: sig.length ? Math.round(sig.reduce((a, b) => a + b, 0) / sig.length) : null,
            worstSignal: sig.length ? Math.min(...sig) : null,
            noIp: st.filter((x) => !x.ip || x.ip === '0.0.0.0').length,
          };
          this.live.set(d.id, st);
        } else if ('error' in radio) {
          s.error = radio.error;
        }
        const prev = this.latest.get(d.id);
        this.alerts.evaluate(d, roleOf(d, s.radio ? s : prev), s, prev, c.thresholds, 'kind' in radio ? radio.kind : undefined);
        this.latest.set(d.id, s);
        samples.push(s);
      });
      await pool(c.probes, 4, async (pr) => {
        const s: Sample = { t, id: 'probe:' + pr.id, ping: await ping(pr.host, c.pingCount, 56) };
        this.latest.set(s.id, s);
        samples.push(s);
      });
      this.history.add(samples);
      this.events = this.events.slice(0, 300);
      this.lastPoll = t;
    } finally {
      this.polling = false;
      this.schedule(Math.max(15, c.pollSeconds) * 1000);
      this.emit('change');
    }
  }

  private async readRadio(d: DeviceCfg): Promise<{ status?: Sample['radio']; stations?: Station[] } | { error: string; kind: string }> {
    const cl = this.client(d);
    try {
      const st = await cl.status();
      let sta: { raw: unknown; parsed: Station[] } = { raw: null, parsed: [] };
      try {
        sta = await cl.stations();
      } catch {
        /* some builds have no sta.cgi on stations; not fatal */
      }
      this.raw.set(d.id, { status: st.raw, stations: sta.raw, t: Date.now() });
      return { status: st.parsed, stations: sta.parsed };
    } catch (e) {
      const err = e as AirOSError;
      this.raw.set(d.id, { error: err.message, t: Date.now() });
      return { error: err.message, kind: err.kind ?? 'network' };
    }
  }

  state(): AppState {
    const c = this.cfg.config;
    const devices: DeviceState[] = c.devices.map((d) => {
      const latest = this.latest.get(d.id);
      let health: DeviceState['health'] = latest ? 'good' : 'unknown';
      const rank = { good: 0, unknown: 0, warning: 1, serious: 2, critical: 3 } as const;
      for (const a of this.alerts.active.values()) {
        if (a.deviceId === d.id && rank[a.severity] > rank[health]) health = a.severity;
      }
      if (!d.enabled) health = 'unknown';
      return { cfg: d, role: roleOf(d, latest), latest, stationsLive: this.live.get(d.id), health };
    });
    return {
      now: Date.now(),
      version: this.version,
      lastPoll: this.lastPoll,
      polling: this.polling,
      nextPoll: this.nextPoll,
      devices,
      probes: c.probes.map((p) => ({ probe: p, latest: this.latest.get('probe:' + p.id) })),
      chain: c.chain,
      alerts: [...this.alerts.active.values()].sort((a, b) => b.startedAt - a.startedAt),
      events: this.events.slice(0, 150),
      update: this.hooks.update?.() ?? { status: 'unsupported' },
      autostart: this.hooks.autostart?.() ?? null,
      needsSetup: !this.cfg.password(),
    };
  }

  rawFor(id: string) {
    return this.raw.get(id) ?? null;
  }

  worstSeverity(): 'good' | 'warning' | 'serious' | 'critical' {
    let w: 'good' | 'warning' | 'serious' | 'critical' = 'good';
    const rank = { good: 0, warning: 1, serious: 2, critical: 3 };
    for (const a of this.alerts.active.values()) if (rank[a.severity] > rank[w]) w = a.severity;
    return w;
  }

  /** Try a login against one IP with the saved (or given) credentials. */
  async testLogin(ip: string): Promise<{ ok: boolean; message: string; hostname?: string; model?: string; mode?: string }> {
    const cl = new AirOSClient(ip, this.cfg.config.username, this.cfg.password());
    try {
      const { parsed } = await cl.status();
      return { ok: true, message: `Logged in to ${parsed.hostname || ip}`, hostname: parsed.hostname, model: parsed.model, mode: parsed.mode };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }

  /** Scan a /24 for airOS radios and add any that are new. */
  async discover(prefix = '192.168.2', progress?: (done: number) => void): Promise<DeviceCfg[]> {
    const ips = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);
    const known = new Set(this.cfg.config.devices.map((d) => d.ip));
    let done = 0;
    const hits = (
      await pool(ips, 32, async (ip) => {
        const ok = !known.has(ip) && (await AirOSClient.probe(ip));
        progress?.(++done);
        return ok ? ip : null;
      })
    ).filter((x): x is string => !!x);
    const added: DeviceCfg[] = [];
    for (const ip of hits) {
      const r = await this.testLogin(ip);
      const name = r.hostname || `Radio ${ip}`;
      let id = slug(name);
      while (this.cfg.config.devices.some((d) => d.id === id)) id += '-2';
      const site = /monks|mm\b/i.test(name) ? 'Monks Meadow' : /73l|mast 2/i.test(name) ? 'Mast 2' : /house/i.test(name) ? 'House' : 'Lookout';
      const d: DeviceCfg = { id, name, ip, site, role: 'auto', enabled: true };
      this.cfg.config.devices.push(d);
      added.push(d);
    }
    if (added.length) {
      this.cfg.config.devices.sort((a, b) => ipNum(a.ip) - ipNum(b.ip));
      this.cfg.save();
      this.emit('change');
    }
    return added;
  }

  configChanged() {
    const ids = new Set(this.cfg.config.devices.filter((d) => d.enabled).map((d) => d.id));
    for (const a of [...this.alerts.active.values()]) if (!ids.has(a.deviceId)) this.alerts.forget(a.deviceId);
    this.clients.clear();
    if (!this.polling) this.schedule(1500);
    this.emit('change');
  }
}

function ipNum(ip: string) {
  return ip.split('.').reduce((a, b) => a * 256 + (parseInt(b, 10) || 0), 0);
}
