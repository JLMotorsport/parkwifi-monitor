import type { AlertItem, DeviceCfg, Role, Sample, Severity, Thresholds } from './types';

export function roleOf(cfg: DeviceCfg, s?: Sample): Role {
  if (cfg.role !== 'auto') return cfg.role;
  const r = s?.radio;
  if (!r) return 'unknown';
  if (r.mode.includes('sta')) return 'backbone-sta';
  if (r.mode.includes('ap')) return r.wds ? 'backbone-ap' : 'ap';
  return 'unknown';
}

const fmt = (n: number | null | undefined, unit = '') => (n === null || n === undefined ? '-' : `${n}${unit}`);

export interface AlertSink {
  raised(a: AlertItem): void;
  resolved(a: AlertItem): void;
  event(a: AlertItem): void;
}

/**
 * Conditions must hold for several polls in a row before an alert is raised, and clear
 * on the first good poll. One-off events (restart, channel change) are logged immediately.
 */
export class AlertEngine {
  readonly active = new Map<string, AlertItem>();
  private streak = new Map<string, number>();

  constructor(private sink: AlertSink) {}

  evaluate(cfg: DeviceCfg, role: Role, s: Sample, prev: Sample | undefined, th: Thresholds, errorKind?: string) {
    const name = cfg.name;
    const cond = (kind: string, bad: boolean, severity: Severity, title: string, detail: string, sustain = th.sustainPolls) => {
      const key = `${cfg.id}:${kind}`;
      if (bad) {
        const n = (this.streak.get(key) ?? 0) + 1;
        this.streak.set(key, n);
        const cur = this.active.get(key);
        if (cur) cur.detail = detail;
        else if (n >= sustain) {
          const a: AlertItem = { key, deviceId: cfg.id, deviceName: name, severity, title, detail, startedAt: s.t };
          this.active.set(key, a);
          this.sink.raised(a);
        }
      } else {
        this.streak.delete(key);
        const cur = this.active.get(key);
        if (cur) {
          this.active.delete(key);
          this.sink.resolved({ ...cur, resolvedAt: s.t });
        }
      }
    };
    const event = (kind: string, severity: Severity, title: string, detail: string) =>
      this.sink.event({ key: `${cfg.id}:${kind}:${s.t}`, deviceId: cfg.id, deviceName: name, severity, title, detail, startedAt: s.t, resolvedAt: s.t, event: true });

    const p = s.ping;
    const offline = p.received === 0 && !s.radio;
    cond('offline', offline, 'critical', `${name} is not responding`, `No ping replies from ${cfg.ip} and no airOS response`, 2);
    if (offline) return;

    cond('loss', p.lossPct > th.lossPct, 'serious', `Packet loss to ${name}`, `${p.lossPct}% of ${p.sent} pings lost`);
    cond(
      'latency',
      p.avg !== null && p.avg > th.latencyMs,
      'warning',
      `Slow replies from ${name}`,
      `Average ${fmt(p.avg, ' ms')}, worst ${fmt(p.max, ' ms')} (limit ${th.latencyMs} ms)`,
    );
    cond('auth', errorKind === 'auth', 'warning', `Can't log in to ${name}`, s.error ?? 'Login rejected', 1);
    cond(
      'api',
      !s.radio && errorKind !== undefined && errorKind !== 'auth',
      'warning',
      `${name} answers ping but not its web interface`,
      s.error ?? 'No response from airOS',
    );

    const r = s.radio;
    if (!r) return;
    const pr = prev?.radio;
    if (pr?.uptime != null && r.uptime != null && r.uptime + 5 < pr.uptime) {
      event('reboot', 'serious', `${name} restarted`, `Uptime dropped from ${Math.round(pr.uptime / 60)} min to ${Math.round(r.uptime / 60)} min (power, PoE, cable or crash)`);
    }
    if (pr?.frequency && r.frequency && pr.frequency !== r.frequency) {
      const dfs = r.frequency > 5000 ? ' On 5 GHz this is usually a radar (DFS) jump.' : '';
      event('channel', 'warning', `${name} changed channel`, `${pr.frequency} MHz to ${r.frequency} MHz.${dfs}`);
    }

    if (role === 'backbone-sta') {
      const weak =
        (r.ccq !== null && r.ccq < th.backboneCcq) || (r.airmaxCapacity !== null && r.airmaxCapacity < th.backboneCapacity);
      cond(
        'link',
        weak,
        'warning',
        `Backbone link into ${name} is weak`,
        `CCQ ${fmt(r.ccq, '%')}, airMAX capacity ${fmt(r.airmaxCapacity, '%')}, rates ${fmt(r.txRate)}/${fmt(r.rxRate)} Mbps, signal ${fmt(r.signal, ' dBm')}`,
      );
    }
    if (role === 'ap') {
      cond(
        'noise',
        r.noise !== null && r.noise > th.apNoise,
        'warning',
        `${name} channel is noisy`,
        `Noise floor ${fmt(r.noise, ' dBm')} on ${fmt(r.frequency, ' MHz')} (limit ${th.apNoise} dBm). Phones further out won't be heard.`,
        th.sustainPolls * 2,
      );
    }
  }

  /** Drop alerts for devices that were deleted or disabled. */
  forget(deviceId: string) {
    for (const k of [...this.active.keys()]) if (k.startsWith(deviceId + ':')) this.active.delete(k);
    for (const k of [...this.streak.keys()]) if (k.startsWith(deviceId + ':')) this.streak.delete(k);
  }
}
