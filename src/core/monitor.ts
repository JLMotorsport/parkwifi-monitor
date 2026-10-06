import { EventEmitter } from 'events';
import { AirOSClient, AirOSError } from './airos';
import { advise, isAccessPoint } from './advisor';
import { AirOSSsh } from './airos-ssh';
import { AlertEngine, roleOf } from './alerts';
import { ChangeManager } from './changes';
import { GatewayPoller } from './gateway';
import { ConfigStore, SecretBox, slug } from './config';
import { ping, reach } from './ping';
import { HistoryStore } from './store';
import type { AlertItem, AppState, DeviceCfg, DeviceState, Sample, SpeedTestRecord, Station, UpdateInfo } from './types';

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
  speedTestRunning: string | null = null;
  readonly changes: ChangeManager;
  private gateways = new Map<string, GatewayPoller>();
  private gwLatest = new Map<string, Sample>();
  private lastAdvice: ReturnType<Monitor['adviceInput']> | null = null;

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
    this.changes = new ChangeManager(dataDir, {
      suggestions: () => this.suggestions(),
      device: (id) => {
        const st = this.deviceStates().find((d) => d.cfg.id === id);
        return st ? { ip: st.cfg.ip, name: st.cfg.name, isAp: isAccessPoint(st, this.cfg.config.chain) } : null;
      },
      history: (id, hours) => this.history.range(id, hours),
      sample: (id) => this.sampleDevice(id),
      ssh: (ip) => new AirOSSsh(ip, this.cfg.config.username, this.cfg.password(), this.cfg.config.sshPort ?? 22),
      trialMinutes: () => Math.min(30, Math.max(3, this.cfg.config.trialMinutes ?? 10)),
      thresholds: () => this.cfg.config.thresholds,
      changed: () => this.emit('change'),
      log: (msg) => console.log(`[changes] ${msg}`),
    });
  }

  suggestions() {
    return advise(this.adviceInput(this.deviceStates()));
  }

  private adviceInput(devices: DeviceState[]) {
    const c = this.cfg.config;
    const g = c.gateways?.find((x) => x.enabled);
    let gateway;
    if (g) {
      const latest = this.gwLatest.get(g.id)?.gw;
      // busiest minutes over the last three days, so one odd evening doesn't decide it
      const peaks = this.history
        .range('gw:' + g.id, 72, Number.MAX_SAFE_INTEGER)
        .map((s) => s.gw?.watch)
        .filter((w): w is NonNullable<typeof w> => !!w);
      const p95 = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))] : null);
      gateway = {
        id: 'gw:' + g.id,
        name: g.name,
        stats: latest,
        peakDown95: p95(peaks.map((w) => w.downPeak)),
        peakUp95: p95(peaks.map((w) => w.upPeak)),
        samples: peaks.length,
        capacity: c.backboneMbps ?? 60,
      };
    }
    return { devices, chain: c.chain, events: this.events, thresholds: c.thresholds, now: Date.now(), gateway };
  }

  /** Start, restart or stop gateway pollers to match the config. */
  private syncGateways() {
    const cfgs = this.cfg.config.gateways ?? [];
    for (const [id, p] of this.gateways) {
      if (!cfgs.some((g) => g.id === id)) {
        p.stop();
        this.gateways.delete(id);
      }
    }
    for (const g of cfgs) {
      let p = this.gateways.get(g.id);
      if (!p) {
        const cur = g;
        p = new GatewayPoller(cur, () => this.cfg.open(this.cfg.config.gateways?.find((x) => x.id === cur.id)?.passwordEnc ?? ''), () => this.emit('change'));
        this.gateways.set(g.id, p);
        const prev = this.history.previous('gw:' + g.id);
        if (prev) this.gwLatest.set(g.id, prev);
      }
      p.cfg = g;
      p.start();
    }
  }

  async testGateway(id: string) {
    const p = this.gateways.get(id);
    if (!p) return { ok: false, message: 'Unknown gateway', ports: [] };
    return p.test();
  }

  start() {
    this.schedule(2000);
    this.syncGateways();
    void this.changes.recover();
  }

  stop() {
    this.changes.shutdown();
    for (const p of this.gateways.values()) p.stop();
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
        const { s, kind } = await this.measure(d, t, hasPassword);
        const prev = this.latest.get(d.id);
        this.alerts.evaluate(d, roleOf(d, s.radio ? s : prev), s, prev, c.thresholds, kind);
        this.latest.set(d.id, s);
        samples.push(s);
      });
      await pool(c.probes, 4, async (pr) => {
        const s: Sample = { t, id: 'probe:' + pr.id, ping: await reach(pr.host, c.pingCount, 56) };
        this.latest.set(s.id, s);
        samples.push(s);
      });
      for (const [id, p] of this.gateways) {
        const s = p.flush(t);
        if (s) {
          this.gwLatest.set(id, s);
          samples.push(s);
        }
      }
      this.history.add(samples);
      this.events = this.events.slice(0, 300);
      this.lastPoll = t;
    } finally {
      this.polling = false;
      this.schedule(Math.max(15, c.pollSeconds) * 1000);
      this.emit('change');
    }
  }

  /** Ping and read one radio. Used by the poll loop and by change trials. */
  private async measure(d: DeviceCfg, t: number, hasPassword: boolean): Promise<{ s: Sample; kind?: string }> {
    const c = this.cfg.config;
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
    return { s, kind: 'kind' in radio ? radio.kind : undefined };
  }

  /** One extra reading of a single radio, stored like a normal poll (no alerting). */
  async sampleDevice(id: string): Promise<Sample | null> {
    const d = this.cfg.config.devices.find((x) => x.id === id);
    if (!d) return null;
    const { s } = await this.measure(d, Date.now(), !!this.cfg.password());
    this.latest.set(d.id, s);
    this.history.add([s]);
    this.emit('change');
    return s;
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
      // start the next poll with a fresh connection rather than reusing one that failed
      this.clients.delete(d.id);
      this.raw.set(d.id, { error: err.message, t: Date.now() });
      return { error: err.message, kind: err.kind ?? 'network' };
    }
  }

  private deviceStates(): DeviceState[] {
    const c = this.cfg.config;
    return c.devices.map((d) => {
      const latest = this.latest.get(d.id);
      let health: DeviceState['health'] = latest ? 'good' : 'unknown';
      const rank = { good: 0, unknown: 0, warning: 1, serious: 2, critical: 3 } as const;
      for (const a of this.alerts.active.values()) {
        if (a.deviceId === d.id && rank[a.severity] > rank[health]) health = a.severity;
      }
      if (!d.enabled) health = 'unknown';
      return { cfg: d, role: roleOf(d, latest), latest, stationsLive: this.live.get(d.id), health };
    });
  }

  state(): AppState {
    const c = this.cfg.config;
    const devices = this.deviceStates();
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
      speedTestRunning: this.speedTestRunning,
      suggestions: advise((this.lastAdvice = this.adviceInput(devices))),
      gateways: (c.gateways ?? []).map((g) => {
        const { passwordEnc, ...rest } = g;
        const p = this.gateways.get(g.id);
        const adv = this.lastAdvice?.gateway;
        const load = adv && adv.id === 'gw:' + g.id ? { peakDown95: adv.peakDown95, peakUp95: adv.peakUp95, samples: adv.samples } : undefined;
        return { cfg: { ...rest, hasPassword: !!passwordEnc }, latest: this.gwLatest.get(g.id), error: p?.error || undefined, errorAt: p?.errorAt || undefined, load };
      }),
      backboneMbps: c.backboneMbps ?? 60,
      trial: this.changes.trial,
      changes: this.changes.history.slice(0, 20),
    };
  }

  /**
   * Runs airOS's own speed test from one radio to another. One at a time: a test fills the
   * links it crosses, so customers on them slow down while it runs.
   */
  async speedTest(fromId: string, toId: string, direction: 'dx' | 'tx' | 'rx', duration: number, port?: number): Promise<SpeedTestRecord> {
    const c = this.cfg.config;
    const from = c.devices.find((d) => d.id === fromId);
    const to = c.devices.find((d) => d.id === toId);
    if (!from || !to) throw new Error('Unknown radio');
    if (this.speedTestRunning) throw new Error('A speed test is already running');
    this.speedTestRunning = fromId;
    this.emit('change');
    const p = port ?? c.speedTestPort ?? 80;
    const d = Math.min(60, Math.max(5, Math.round(duration) || 10));
    const rec: SpeedTestRecord = {
      t: Date.now(),
      fromId,
      fromName: from.name,
      toId,
      toName: to.name,
      direction,
      duration: d,
      port: p,
      ok: false,
      tx: null,
      rx: null,
      message: '',
    };
    try {
      const cl = new AirOSClient(from.ip, c.username, this.cfg.password(), 15000);
      const r = await cl.speedTest({ target: to.ip, port: p, user: c.username, pass: this.cfg.password(), duration: d, direction });
      Object.assign(rec, { ok: r.ok, tx: r.tx, rx: r.rx, message: r.message });
    } catch (e) {
      rec.message = (e as Error).message;
    } finally {
      this.speedTestRunning = null;
      this.history.logSpeedTest(rec);
      this.emit('change');
    }
    return rec;
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
    this.syncGateways();
    if (!this.polling) this.schedule(1500);
    this.emit('change');
  }
}

function ipNum(ip: string) {
  return ip.split('.').reduce((a, b) => a * 256 + (parseInt(b, 10) || 0), 0);
}
