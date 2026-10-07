import type { Monitor } from './monitor';
import type { Sample } from './types';
import { roleOf } from './alerts';

const r1 = (n: number) => Math.round(n * 10) / 10;
const mean = (xs: number[]) => (xs.length ? r1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const min = (xs: number[]) => (xs.length ? Math.min(...xs) : null);
const max = (xs: number[]) => (xs.length ? Math.max(...xs) : null);
const pct = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const nums = (xs: (number | null | undefined)[]) => xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));

/** Collapse one device's samples into stats: used per hour and for the whole range. */
function summarise(all: Sample[]) {
  // readings taken while this PC's own connection was poor say nothing about the radios' ping
  const rows = all.filter((s) => !s.pcFault);
  const avg = nums(rows.map((s) => s.ping.avg));
  const worst = nums(rows.map((s) => s.ping.max));
  const r = all.map((s) => s.radio);
  const st = all.map((s) => s.stations);
  return {
    polls: all.length,
    pcFaultPolls: all.length - rows.length,
    noReplyPolls: rows.filter((s) => s.ping.received === 0).length,
    readErrors: all.filter((s) => !!s.error).length,
    pingAvgMs: mean(avg),
    pingP95Ms: pct(avg, 95),
    pingWorstMs: max(worst),
    lossAvgPct: mean(rows.map((s) => s.ping.lossPct)),
    signalMin: min(nums(r.map((x) => x?.signal))),
    noiseMax: max(nums(r.map((x) => x?.noise))),
    ccqMin: min(nums(r.map((x) => x?.ccq)).filter((x) => x > 0)),
    capacityMin: min(nums(r.map((x) => x?.airmaxCapacity))),
    txRateMin: min(nums(r.map((x) => x?.txRate))),
    rxRateMin: min(nums(r.map((x) => x?.rxRate))),
    clientsMax: max(nums(st.map((x) => x?.count))),
    weakClientsMax: max(nums(st.map((x) => x?.weak))),
    noIpMax: max(nums(st.map((x) => x?.noIp))),
  };
}

/** Drop keys whose value is null so the file stays readable. */
function compact<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<T>;
}

/**
 * One self-contained JSON file describing the last `hours` of the network: settings (no
 * password), per-radio totals and hourly stats, every alert/restart/channel change, and the
 * latest raw airOS data. Built to be attached to a chat for analysis.
 */
export function buildExport(m: Monitor, hours: number) {
  const st = m.state();
  const c = m.cfg.config;
  const from = Date.now() - hours * 3600 * 1000;
  const iso = (t: number) => new Date(t).toISOString();

  const targets = [
    ...st.devices.map((d) => ({ id: d.cfg.id, name: d.cfg.name, ip: d.cfg.ip, site: d.cfg.site, enabled: d.cfg.enabled, role: d.role, cfgRole: d.cfg.role })),
    ...st.probes.map((p) => ({ id: 'probe:' + p.probe.id, name: p.probe.name, ip: p.probe.host, site: '', enabled: true, role: 'ping-only', cfgRole: 'ping-only' })),
  ];

  const net = (st.probes.find((p) => p.probe.id === 'internet') ?? st.probes[0])?.latest?.ping;
  const devices = targets.map((t) => {
    const rows = m.history.range(t.id, hours, Number.MAX_SAFE_INTEGER);
    const byHour = new Map<number, Sample[]>();
    for (const s of rows) {
      const h = Math.floor(s.t / 3600000) * 3600000;
      if (!byHour.has(h)) byHour.set(h, []);
      byHour.get(h)!.push(s);
    }
    const latest = st.devices.find((d) => d.cfg.id === t.id);
    const uptimes = rows.map((s) => s.radio?.uptime);
    let restarts = 0;
    for (let i = 1; i < uptimes.length; i++) {
      const a = uptimes[i - 1];
      const b = uptimes[i];
      if (a != null && b != null && b + 5 < a) restarts++;
    }
    const freqs = [...new Set(nums(rows.map((s) => s.radio?.frequency)))];
    return {
      ...t,
      role: latest ? roleOf(latest.cfg, latest.latest) : t.role,
      health: latest?.health,
      estInternetMsNow:
        net?.avg != null && net.received && latest?.latest?.ping.avg != null && latest.latest.ping.received
          ? Math.round(latest.latest.ping.avg + net.avg)
          : undefined,
      latest: latest?.latest ? { ...latest.latest, t: iso(latest.latest.t), stationsLive: latest.stationsLive } : undefined,
      totals: { ...compact(summarise(rows)), restartsSeen: restarts, frequenciesSeen: freqs },
      hourly: [...byHour.entries()].sort((a, b) => a[0] - b[0]).map(([h, rs]) => ({ hour: iso(h), ...compact(summarise(rs)) })),
      lastRawFromRadio: m.rawFor(t.id),
    };
  });

  const { passwordEnc: _omit, ...safeConfig } = c;
  return {
    exportedAt: iso(Date.now()),
    app: { name: 'Park WiFi Monitor', version: m.version, platform: process.platform },
    range: { hours, from: iso(from), to: iso(Date.now()) },
    notes: [
      'Ping figures are measured from the PC running the app, so each backbone hop includes all hops before it.',
      'Hourly rows: pingAvgMs = mean of per-poll averages, pingP95Ms = 95th percentile of those, pingWorstMs = single worst reply.',
      'signalMin/ccqMin/capacityMin/txRateMin are the lowest values seen in the hour; noiseMax/clientsMax/weakClientsMax the highest.',
      'estInternetMsNow = this radio\'s ping plus the office PC\'s internet ping: an estimate of what a customer there sees, not a measurement from the radio.',
      'gateways[].hourly: radio port = the gateway port feeding the backbone; Down = towards the caravans. Peaks are the busiest 15 s reading in each minute, then the highest of those in the hour.',
      'pcFaultPolls = polls taken while the PC running the app had a poor connection itself (its own router or internet was slow too). Their ping figures are left out of the stats.',
      'ccqMin ignores readings of 0, which an AP reports when nobody is connected.',
      'floodPps = broadcast + multicast packets per second on the radio-feeding port; every device on the radios has to hear these. Under about 60 is normal.',
      `A client counts as weak at or below ${c.thresholds.weakSignal} dBm.`,
    ],
    settings: { ...safeConfig, server: { ...safeConfig.server, token: '(removed)' } },
    backboneOrder: c.chain,
    suggestions: st.suggestions.map(({ id, kind, deviceName, severity, title, change }) => ({ id, kind, deviceName, severity, title, change })),
    changesMade: m.changes.history
      .filter((t) => t.startedAt >= from)
      .map((t) => ({ ...t, startedAt: iso(t.startedAt), endedAt: t.endedAt ? iso(t.endedAt) : undefined, trialEndsAt: undefined })),
    activeAlerts: st.alerts.map((a) => ({ ...a, startedAt: iso(a.startedAt) })),
    events: m.history
      .recentAlerts(2000)
      .filter((a) => a.startedAt >= from || (a.resolvedAt ?? 0) >= from)
      .map((a) => ({ ...a, startedAt: iso(a.startedAt), resolvedAt: a.resolvedAt ? iso(a.resolvedAt) : undefined })),
    devices,
    gateways: (c.gateways ?? []).map((g) => {
      const rows = m.history.range('gw:' + g.id, hours).filter((s) => s.gw);
      const byHour = new Map<number, Sample[]>();
      for (const s of rows) {
        const h = Math.floor(s.t / 3600000) * 3600000;
        if (!byHour.has(h)) byHour.set(h, []);
        byHour.get(h)!.push(s);
      }
      const last = rows[rows.length - 1]?.gw;
      return {
        id: g.id,
        name: g.name,
        host: g.host,
        enabled: g.enabled,
        watchedPort: last?.watch?.name,
        latest: last ? { ...last, ports: last.ports } : undefined,
        hourly: [...byHour.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([h, rs]) => {
            const w = rs.map((s) => s.gw!.watch).filter((x): x is NonNullable<typeof x> => !!x);
            const lat = nums(rs.map((s) => s.gw!.wanLatency));
            const nets = rs[rs.length - 1].gw!.networks;
            return compact({
              hour: iso(h),
              radioPortDownAvgMbps: mean(w.map((x) => x.downMbps)),
              radioPortDownPeakMbps: max(w.map((x) => x.downPeak)),
              radioPortUpAvgMbps: mean(w.map((x) => x.upMbps)),
              radioPortUpPeakMbps: max(w.map((x) => x.upPeak)),
              floodAvgPps: mean(nums(w.map((x) => x.floodPps))),
              floodPeakPps: max(nums(w.map((x) => x.floodPeakPps))),
              floodFromGatewayAvgPps: mean(nums(w.map((x) => x.floodFromGatewayPps))),
              wanLatencyAvgMs: mean(lat),
              wanLatencyWorstMs: max(lat),
              clientsByNetwork: nets.map((n) => `${n.name}: ${n.clients}${n.poolSize ? '/' + n.poolSize : ''}`).join(', ') || null,
            });
          }),
      };
    }),
  };
}
