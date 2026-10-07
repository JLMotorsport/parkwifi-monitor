import { describe, expect, it } from 'vitest';
import { AlertEngine, pcFault } from '../src/core/alerts';
import { advise, channelQuality, freqOf } from '../src/core/advisor';
import { floodRate, readCounters } from '../src/core/unifi';
import type { AlertItem, DeviceCfg, DeviceState, GatewayStats, PingResult, RadioStatus, Sample, Thresholds } from '../src/core/types';

const th: Thresholds = { latencyMs: 40, lossPct: 5, backboneCcq: 90, backboneCapacity: 80, weakSignal: -75, apNoise: -80, sustainPolls: 3 };
const ok = (avg = 8): PingResult => ({ sent: 5, received: 5, lossPct: 0, avg, min: avg, max: avg });
const slow = (avg = 280, loss = 30): PingResult => ({ sent: 5, received: 4, lossPct: loss, avg, min: avg, max: avg * 2 });
const none: PingResult = { sent: 5, received: 0, lossPct: 100, avg: null, min: null, max: null };

describe('pcFault', () => {
  it('blames the PC when the first radio and the internet are both slow but UDR3 sees the internet fine', () => {
    const r = pcFault({ firstHop: slow(), internet: slow(287, 44), devices: [slow(), slow()], gatewayWanLatency: 11 }, th);
    expect(r).toContain('between this PC and UDR3');
  });
  it('blames the PC when its own router answers slowly', () => {
    expect(pcFault({ firstHop: ok(), internet: ok(), router: slow(272, 42), devices: [ok()] }, th)).toContain('router');
  });
  it('does not blame the PC when the router simply ignores ping', () => {
    expect(pcFault({ firstHop: ok(), internet: ok(), router: none, devices: [ok()] }, th)).toBeNull();
  });
  it('reports no connection when nothing answers at all', () => {
    expect(pcFault({ firstHop: none, internet: none, devices: [none, none] }, th)).toContain('no network connection');
  });
  it('blames the radio, not the PC, when only the radios are slow', () => {
    expect(pcFault({ firstHop: slow(), internet: ok(13), devices: [slow(), slow()], gatewayWanLatency: 11 }, th)).toBeNull();
    expect(pcFault({ firstHop: ok(), internet: ok(), devices: [ok(), slow()] }, th)).toBeNull();
  });
  it('does not blame the PC when UDR3 itself sees a slow internet', () => {
    expect(pcFault({ firstHop: slow(), internet: slow(), devices: [slow()], gatewayWanLatency: 300 }, th)).toBeNull();
  });
});

function engine() {
  const raised: AlertItem[] = [];
  const resolved: AlertItem[] = [];
  const e = new AlertEngine({ raised: (a) => raised.push(a), resolved: (a) => resolved.push(a), event: () => undefined });
  return { e, raised, resolved };
}
const cfg: DeviceCfg = { id: 'r1', name: 'Radio 1', ip: '10.0.0.1', site: 'L', role: 'auto', enabled: true };
const sample = (t: number, p: PingResult): Sample => ({ t, id: 'r1', ping: p });

describe('AlertEngine while the PC is the problem', () => {
  it('raises one PC alert and no radio alerts', () => {
    const { e, raised } = engine();
    for (let t = 1; t <= 5; t++) {
      e.pc('bad', t);
      e.evaluate(cfg, 'ap', sample(t, slow()), undefined, th, undefined, true);
    }
    expect(raised.map((a) => a.key)).toEqual(['pc:connection']);
  });
  it('leaves an existing radio alert alone rather than clearing it on readings that say nothing', () => {
    const { e, resolved } = engine();
    for (let t = 1; t <= 3; t++) e.evaluate(cfg, 'ap', sample(t, slow()), undefined, th);
    expect(e.active.has('r1:latency')).toBe(true);
    e.evaluate(cfg, 'ap', sample(4, ok()), undefined, th, undefined, true);
    expect(e.active.has('r1:latency')).toBe(true);
    expect(resolved).toHaveLength(0);
    e.evaluate(cfg, 'ap', sample(5, ok()), undefined, th);
    expect(e.active.has('r1:latency')).toBe(false);
  });
  it('clears the PC alert when the connection recovers', () => {
    const { e, resolved } = engine();
    e.pc('bad', 1);
    e.pc('bad', 2);
    e.pc(null, 3);
    expect(resolved.map((a) => a.key)).toEqual(['pc:connection']);
  });
});

const gw = (floodPps: number | null, fromGw: number | null = null): GatewayStats => ({
  name: 'UDR3', model: 'UDR', uptime: 1, cpu: 1, mem: 1, wanLatency: 11, wanUp: true, wanDownMbps: 1, wanUpMbps: 1, ports: [], networks: [],
  watch: { idx: 2, name: 'Lookout&Monks', downMbps: 1, upMbps: 1, downPeak: 2, upPeak: 2, readings: 4, floodPps, floodPeakPps: floodPps, floodFromGatewayPps: fromGw },
});

describe('flood alert', () => {
  it('needs a sustained flood, and names UDR3 when most of it comes from there', () => {
    const { e, raised } = engine();
    e.gateway('gw:udr3', 'UDR3', gw(320, 260), 1, th);
    e.gateway('gw:udr3', 'UDR3', gw(320, 260), 2, th);
    expect(raised).toHaveLength(0);
    e.gateway('gw:udr3', 'UDR3', gw(320, 260), 3, th);
    expect(raised[0].severity).toBe('serious');
    expect(raised[0].detail).toContain('mDNS proxy');
  });
  it('stays quiet at normal levels and when the gateway reports no counters', () => {
    const { e, raised } = engine();
    for (let t = 1; t <= 5; t++) e.gateway('gw:udr3', 'UDR3', gw(50, 10), t, th);
    for (let t = 6; t <= 9; t++) e.gateway('gw:udr3', 'UDR3', gw(null), t, th);
    expect(raised).toHaveLength(0);
  });
  it('appears as advice that points at a device when UDR3 is not the source', () => {
    const s = advise({ devices: [], chain: [], events: [], thresholds: th, now: 1, gateway: { id: 'gw:udr3', name: 'UDR3', stats: gw(200, 20), peakDown95: null, peakUp95: null, samples: 0, capacity: 60 } });
    const f = s.find((x) => x.kind === 'flood')!;
    expect(f.severity).toBe('warning');
    expect(f.fix).toContain('MAC ACL');
  });
});

describe('flood counters', () => {
  it('turns broadcast and multicast counters into packets per second', () => {
    const port = (b: number, m: number) => ({ device: { port_table: [{ port_idx: 2, rx_bytes: 0, tx_bytes: 0, tx_broadcast: b, tx_multicast: m, rx_broadcast: 0, rx_multicast: 10 }] } });
    const a = readCounters(port(100, 1000).device, 0);
    const b = readCounters(port(400, 4000).device, 15000);
    expect(floodRate(a, b, 2, 'txFlood')).toBe(220);
    expect(floodRate(a, b, 2, 'rxFlood')).toBe(0);
  });
  it('gives null when the gateway does not report them', () => {
    const d = { port_table: [{ port_idx: 2, rx_bytes: 0, tx_bytes: 0 }] };
    expect(floodRate(readCounters(d, 0), readCounters(d, 15000), 2, 'txFlood')).toBeNull();
  });
});

function radio(p: Partial<RadioStatus>): RadioStatus {
  return {
    hostname: '', model: '', firmware: '', uptime: 1000, mode: 'ap', wds: false, essid: '', frequency: null, channel: null, channelWidth: 20,
    signal: null, noise: -90, ccq: 90, txRate: null, rxRate: null, txPower: 17, airmaxQuality: null, airmaxCapacity: null, stationCount: 0,
    cpu: 5, memPct: 50, lanSpeed: 100, security: '', ...p,
  };
}
const hist = (freq: number, ccq: number, n: number, clients = 3): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ t: i, id: 'a4', ping: ok(), radio: radio({ frequency: freq, ccq }), stations: { count: clients, weak: 0, avgSignal: -70, worstSignal: -75, noIp: 0 } }));

describe('channel history', () => {
  it('takes the median CCQ per channel and ignores readings with nobody connected', () => {
    const q = channelQuality([...hist(2412, 60, 40), ...hist(2437, 88, 40), ...hist(2437, 0, 20, 0)]);
    expect(q[2412]).toEqual({ ccq: 60, samples: 40 });
    expect(q[2437]).toEqual({ ccq: 88, samples: 40 });
  });

  const ap = (id: string, ch: number, clients: number): DeviceState => ({
    cfg: { id, name: id, ip: '10.0.0.' + id.length, site: 'Lookout', role: 'auto', enabled: true },
    role: 'ap',
    health: 'good',
    latest: { t: 0, id, ping: ok(), radio: radio({ channel: ch, frequency: freqOf(ch), ccq: 85 }), stations: { count: clients, weak: 0, avgSignal: -70, worstSignal: -80, noIp: 0 } },
  });
  // four APs on one site: the plan wants one of them on channel 1
  const aps = [ap('a1', 11, 5), ap('a2', 6, 9), ap('a3', 11, 2), ap('a4', 6, 4)];
  const run = (channelHistory?: Record<string, ReturnType<typeof channelQuality>>) =>
    advise({ devices: aps, chain: [], events: [], thresholds: th, now: 1, channelHistory }).find((x) => x.id === 'channel:a4');

  it('suggests the plan channel when there is no history', () => {
    expect(run()?.change).toEqual({ frequency: 2412 });
  });
  it('does not send an AP back to a channel where its devices did worse', () => {
    const s = run({ a4: channelQuality([...hist(2412, 62, 60), ...hist(2437, 85, 60)]) })!;
    expect(s.change).toBeUndefined();
    expect(s.severity).toBe('info');
    expect(s.title).toBe('Leave a4 on channel 6 for now');
    expect(s.why).toContain('62%');
  });
  it('still suggests it when the old channel was as good, or there is too little history', () => {
    expect(run({ a4: channelQuality([...hist(2412, 83, 60), ...hist(2437, 85, 60)]) })?.change).toEqual({ frequency: 2412 });
    expect(run({ a4: channelQuality([...hist(2412, 40, 10), ...hist(2437, 85, 60)]) })?.change).toEqual({ frequency: 2412 });
  });
});
