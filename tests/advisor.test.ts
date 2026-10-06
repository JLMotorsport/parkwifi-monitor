import { describe, expect, it } from 'vitest';
import { advise, channelPlan, freqOf } from '../src/core/advisor';
import type { AlertItem, DeviceState, RadioStatus, Thresholds } from '../src/core/types';

const th: Thresholds = { latencyMs: 40, lossPct: 10, backboneCcq: 90, backboneCapacity: 80, weakSignal: -75, apNoise: -80, sustainPolls: 3 };

function radio(p: Partial<RadioStatus>): RadioStatus {
  return {
    hostname: '', model: '', firmware: '', uptime: 1000, mode: 'ap', wds: false, essid: '', frequency: null, channel: null, channelWidth: 20,
    signal: null, noise: -90, ccq: 90, txRate: null, rxRate: null, txPower: 17, airmaxQuality: null, airmaxCapacity: null, stationCount: 0,
    cpu: 5, memPct: 50, lanSpeed: 100, security: '', ...p,
  };
}
function ap(id: string, site: string, ch: number, extra: Partial<RadioStatus> = {}, clients = 2, weak = 0, noIp = 0): DeviceState {
  return {
    cfg: { id, name: id, ip: '10.0.0.' + id.length, site, role: 'auto', enabled: true },
    role: 'ap',
    health: 'good',
    latest: {
      t: 0, id,
      ping: { sent: 5, received: 5, lossPct: 0, avg: 5, min: 5, max: 5 },
      radio: radio({ channel: ch, frequency: freqOf(ch), ...extra }),
      stations: { count: clients, weak, avgSignal: -70, worstSignal: -80, noIp },
    },
  };
}
function sta(id: string, site: string, avg: number, extra: Partial<RadioStatus> = {}): DeviceState {
  return {
    cfg: { id, name: id, ip: '10.0.1.' + id.length, site, role: 'auto', enabled: true },
    role: 'backbone-sta',
    health: 'good',
    latest: { t: 0, id, ping: { sent: 5, received: 5, lossPct: 0, avg, min: avg, max: avg }, radio: radio({ mode: 'sta', frequency: 5800, channel: 160, signal: -53, airmaxCapacity: 98, ccq: 99, txRate: 130, rxRate: 130, ...extra }) },
  };
}
const run = (devices: DeviceState[], chain: string[] = [], events: AlertItem[] = []) => advise({ devices, chain, events, thresholds: th, now: 1e12 });

describe('channelPlan', () => {
  it('spreads a site across 1, 6 and 11 and keeps APs already on a free plan channel', () => {
    const p = channelPlan([ap('a1', 'L', 1, {}, 5), ap('a2', 'L', 5, {}, 3), ap('a3', 'L', 9, {}, 2)]);
    expect(p.get('a1')).toBe(1);
    expect(p.get('a2')).toBe(6);
    expect(p.get('a3')).toBe(11);
  });
  it('plans each site separately', () => {
    const p = channelPlan([ap('a1', 'L', 1), ap('b1', 'M', 1)]);
    expect(p.get('a1')).toBe(1);
    expect(p.get('b1')).toBe(1);
  });
  it('ignores 5 GHz access points', () => {
    const p = channelPlan([ap('a1', 'L', 36, { frequency: 5180 })]);
    expect(p.has('a1')).toBe(false);
  });
});

describe('advise', () => {
  it('suggests a channel move with an applicable change', () => {
    const s = run([ap('a1', 'L', 1, {}, 5), ap('a2', 'L', 5, {}, 3)]);
    const c = s.find((x) => x.id === 'channel:a2')!;
    expect(c.change).toEqual({ frequency: 2437 });
    expect(c.why).toContain('a1');
    expect(s.find((x) => x.id === 'channel:a1')).toBeUndefined();
  });
  it('suggests lowering power above 17 dBm only', () => {
    expect(run([ap('a1', 'L', 1, { txPower: 20 })]).find((x) => x.kind === 'power')?.change).toEqual({ txPower: 17 });
    expect(run([ap('a1', 'L', 1, { txPower: 17 })]).find((x) => x.kind === 'power')).toBeUndefined();
  });
  it('gives advice without a change for noise on a good channel', () => {
    const n = run([ap('a1', 'L', 1, { noise: -75 })]).find((x) => x.kind === 'noise')!;
    expect(n.change).toBeUndefined();
  });
  it('never puts a change on a backbone radio', () => {
    const s = run([sta('s1', 'House', 3), sta('s2', 'Mast 2', 60, { airmaxCapacity: 60, txPower: 27 })], ['s1', 's2']);
    expect(s.map((x) => x.kind).sort()).toEqual(['backbone-link']);
    expect(s.every((x) => !x.change)).toBe(true);
  });
  it('flags a slow hop only when the link figures look healthy', () => {
    const s = run([sta('s1', 'Lookout', 5), sta('s2', 'Mast 2', 61)], ['s1', 's2']);
    expect(s.find((x) => x.kind === 'slow-hop')?.title).toContain('56 ms');
    const t = run([sta('s1', 'Lookout', 5), sta('s2', 'Mast 2', 61, { airmaxCapacity: 60 })], ['s1', 's2']);
    expect(t.find((x) => x.kind === 'slow-hop')).toBeUndefined();
  });
  it('treats an AP listed in the backbone chain as backbone', () => {
    expect(run([ap('a1', 'L', 5, { txPower: 28 })], ['a1'])).toEqual([]);
  });
  it('flags repeated restarts in the last day', () => {
    const ev = (t: number): AlertItem => ({ key: `a1:reboot:${t}`, deviceId: 'a1', deviceName: 'a1', severity: 'serious', title: '', detail: '', startedAt: t, event: true });
    expect(run([ap('a1', 'L', 1)], [], [ev(1e12 - 1000), ev(1e12 - 2000)]).find((x) => x.kind === 'restarts')).toBeDefined();
    expect(run([ap('a1', 'L', 1)], [], [ev(1e12 - 1000), ev(1e12 - 90000000)]).find((x) => x.kind === 'restarts')).toBeUndefined();
  });
  it('explains weak clients and missing addresses without offering a change', () => {
    const s = run([ap('a1', 'L', 1, {}, 4, 3, 1)]);
    expect(s.find((x) => x.kind === 'weak-clients')?.change).toBeUndefined();
    expect(s.find((x) => x.kind === 'no-ip')).toBeDefined();
  });
});

describe('gateway advice', () => {
  const stats = (clients: number) => ({
    name: 'UDR3', model: 'UDR', uptime: 1, cpu: 1, mem: 1, wanLatency: 12, wanUp: true, wanDownMbps: 1, wanUpMbps: 1, ports: [],
    networks: [{ name: 'Lookout&Monks', subnet: '192.168.2.1/24', clients, poolSize: 100, leaseSeconds: 86400 }],
  });
  const gw = (clients: number, peak: number | null, samples = 500) => ({ id: 'gw:udr3', name: 'UDR3', stats: stats(clients), peakDown95: peak, peakUp95: 1, samples, capacity: 60 });
  const go = (g: ReturnType<typeof gw>) => advise({ devices: [], chain: [], events: [], thresholds: th, now: 1e12, gateway: g });
  it('warns when the DHCP pool is nearly full and suggests shorter leases', () => {
    const s = go(gw(90, null)).find((x) => x.kind === 'dhcp-full')!;
    expect(s.severity).toBe('warning');
    expect(s.fix).toContain('24 hours');
    expect(go(gw(50, null)).find((x) => x.kind === 'dhcp-full')).toBeUndefined();
  });
  it('calls the backbone full only with enough history', () => {
    expect(go(gw(10, 55)).find((x) => x.kind === 'backbone-full')?.title).toContain('nearly full');
    expect(go(gw(10, 55, 100)).find((x) => x.kind === 'backbone-full')).toBeUndefined();
    expect(go(gw(10, 30)).find((x) => x.kind === 'backbone-full')).toBeUndefined();
  });
});
