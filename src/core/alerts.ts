import type { AlertItem, DeviceCfg, GatewayStats, PingResult, Role, Sample, Severity, Thresholds } from './types';

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
 * The radio a device's traffic passes through just before it: the previous radio in the backbone
 * chain, or for anything else the first backbone radio at its site. Null for the first radio.
 */
export function parentOf(id: string, devices: DeviceCfg[], chain: string[]): string | null {
  const i = chain.indexOf(id);
  if (i > 0) return chain[i - 1];
  if (i === 0) return null;
  const d = devices.find((x) => x.id === id);
  if (!d) return null;
  return chain.find((c) => devices.find((x) => x.id === c)?.site === d.site) ?? null;
}

/** Broadcast + multicast packets/s on the radio port. After the mDNS fix the park ran at about 50. */
export const FLOOD_WARN_PPS = 150;
export const FLOOD_SERIOUS_PPS = 300;

const pingBad = (p: PingResult | undefined, th: Thresholds) =>
  !!p && (p.received === 0 || p.lossPct > th.lossPct || (p.avg !== null && p.avg > th.latencyMs));

export interface PcCheckInput {
  /** first radio in the backbone chain: one cable away from the gateway */
  firstHop?: PingResult;
  internet?: PingResult;
  /** the PC's own router (UDR3), when a probe for it exists */
  router?: PingResult;
  /** every enabled radio's ping this poll */
  devices: PingResult[];
  /** the gateway's own measurement of its internet latency, if it is being read */
  gatewayWanLatency?: number | null;
}

/**
 * Is the PC running the app the problem, rather than the radios? Pure.
 * When the PC's own connection is bad, every radio looks bad at once, which used to raise an
 * alert per radio (469 of them in one evening of testing from a laptop on the park WiFi).
 */
export function pcFault(inp: PcCheckInput, th: Thresholds): string | null {
  const dead = (p?: PingResult) => !p || p.received === 0;
  if (inp.devices.length && inp.devices.every((p) => p.received === 0) && dead(inp.internet)) {
    return 'This PC has no network connection: no radio and no internet address answered.';
  }
  // the router refusing ping entirely is normal (UDR3 does); only a slow or patchy answer counts
  const r = inp.router;
  if (r && r.received > 0 && pingBad(r, th)) {
    return `This PC's own connection to its router is poor (${r.avg ?? '?'} ms, ${r.lossPct}% lost), so every radio looks slow from here.`;
  }
  const gwFine = inp.gatewayWanLatency == null || inp.gatewayWanLatency < th.latencyMs;
  if (pingBad(inp.firstHop, th) && pingBad(inp.internet, th) && gwFine) {
    return `The first radio and the internet are both slow from this PC${inp.gatewayWanLatency != null ? `, while UDR3 itself sees the internet at ${inp.gatewayWanLatency} ms` : ''}. The problem is between this PC and UDR3.`;
  }
  return null;
}

/**
 * Conditions must hold for several polls in a row before an alert is raised, and clear
 * on the first good poll. One-off events (restart, channel change) are logged immediately.
 */
export class AlertEngine {
  readonly active = new Map<string, AlertItem>();
  private streak = new Map<string, number>();

  constructor(private sink: AlertSink) {}

  private check(id: string, name: string, t: number, kind: string, bad: boolean, severity: Severity, title: string, detail: string, sustain: number) {
    const key = `${id}:${kind}`;
    if (bad) {
      const n = (this.streak.get(key) ?? 0) + 1;
      this.streak.set(key, n);
      const cur = this.active.get(key);
      if (cur) {
        cur.detail = detail;
        cur.severity = severity;
      } else if (n >= sustain) {
        const a: AlertItem = { key, deviceId: id, deviceName: name, severity, title, detail, startedAt: t };
        this.active.set(key, a);
        this.sink.raised(a);
      }
    } else {
      this.streak.delete(key);
      const cur = this.active.get(key);
      if (cur) {
        this.active.delete(key);
        this.sink.resolved({ ...cur, resolvedAt: t });
      }
    }
  }

  /** One alert for "this PC's connection is the problem" instead of one per radio. */
  pc(reason: string | null, t: number) {
    this.check('pc', 'This PC', t, 'connection', !!reason, 'warning', "This PC's connection is poor, so radio readings are on hold", reason ?? '', 2);
  }

  /** Gateway checks: a broadcast/multicast flood on the port feeding the radios. */
  gateway(id: string, name: string, g: GatewayStats | undefined, t: number, th: Thresholds) {
    const w = g?.watch;
    const f = w?.floodPps ?? null;
    if (f === null) {
      // no fresh counters this minute (gateway unreachable or not reporting): don't leave an old flood alert up
      this.check(id, name, t, 'flood', false, 'warning', '', '', th.sustainPolls);
      return;
    }
    const fromGw = w?.floodFromGatewayPps;
    const share = fromGw != null && f > 0 ? Math.round((fromGw / f) * 100) : null;
    this.check(
      id,
      name,
      t,
      'flood',
      f >= FLOOD_WARN_PPS,
      f >= FLOOD_SERIOUS_PPS ? 'serious' : 'warning',
      'Broadcast flood on the radios',
      `${f} broadcast and multicast packets a second are reaching every device on the radios (normal is under 60).` +
        (share !== null ? ` ${share}% of them come from ${name} itself, ${share >= 50 ? 'so check its mDNS proxy and multicast settings first' : 'so look for a device on the radios flooding (Fire Stick, Chromecast, smart watch)'}.` : ''),
      th.sustainPolls,
    );
  }

  /**
   * @param pcFault the PC's own connection is bad this poll: ping-based checks are skipped
   * (neither raised nor cleared) because they would only measure this PC.
   */
  evaluate(
    cfg: DeviceCfg,
    role: Role,
    s: Sample,
    prev: Sample | undefined,
    th: Thresholds,
    errorKind?: string,
    pcFault = false,
    parent?: { name: string; ping: PingResult },
  ) {
    const name = cfg.name;
    const cond = (kind: string, bad: boolean, severity: Severity, title: string, detail: string, sustain = th.sustainPolls) =>
      this.check(cfg.id, name, s.t, kind, bad, severity, title, detail, sustain);
    const event = (kind: string, severity: Severity, title: string, detail: string) =>
      this.sink.event({ key: `${cfg.id}:${kind}:${s.t}`, deviceId: cfg.id, deviceName: name, severity, title, detail, startedAt: s.t, resolvedAt: s.t, event: true });

    const p = s.ping;
    if (!pcFault) {
      const offline = p.received === 0 && !s.radio;
      cond('offline', offline, 'critical', `${name} is not responding`, `No ping replies from ${cfg.ip} and no airOS response`, 2);
      if (offline) return;

      // Judge each radio on what it adds on top of the radio before it, so one slow link raises one
      // alert at the right place instead of one for every radio beyond it.
      const pp = parent?.ping;
      const parentLossy = !!pp && pp.received > 0 && pp.lossPct > th.lossPct;
      const lossBad = p.lossPct > th.lossPct && !(parentLossy && p.lossPct - pp!.lossPct <= th.lossPct);
      cond('loss', lossBad, 'serious', `Packet loss to ${name}`, `${p.lossPct}% of ${p.sent} pings lost${parentLossy ? ` (${pp!.lossPct}% already lost by ${parent!.name})` : ''}`);
      const added = pp && pp.avg !== null && p.avg !== null ? Math.round(p.avg - pp.avg) : null;
      const slow = p.avg !== null && (added !== null ? added > th.latencyMs || p.avg > th.latencyMs * 3 : p.avg > th.latencyMs);
      cond(
        'latency',
        slow,
        'warning',
        `Slow replies from ${name}`,
        added !== null
          ? `Average ${fmt(p.avg, ' ms')}, worst ${fmt(p.max, ' ms')}. ${added > th.latencyMs ? `${added} ms of that is added after ${parent!.name}` : `Only ${Math.max(0, added)} ms is added after ${parent!.name}; the delay builds up before it`} (limit ${th.latencyMs} ms per hop).`
          : `Average ${fmt(p.avg, ' ms')}, worst ${fmt(p.max, ' ms')} (limit ${th.latencyMs} ms)`,
      );
      cond(
        'api',
        !s.radio && errorKind !== undefined && errorKind !== 'auth',
        'warning',
        `${name} answers ping but not its web interface`,
        s.error ?? 'No response from airOS',
      );
    }
    cond('auth', errorKind === 'auth', 'warning', `Can't log in to ${name}`, s.error ?? 'Login rejected', 1);

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
