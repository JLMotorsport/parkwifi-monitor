import { describe, expect, it } from 'vitest';
import { AlertEngine, parentOf } from '../src/core/alerts';
import { advise } from '../src/core/advisor';
import { TalkerTracker, correlation, stationRate, suspectReason } from '../src/core/flood';
import { clientInfo } from '../src/core/gateway';
import { parsePingSeries } from '../src/core/ping';
import { analyseTrace } from '../src/core/trace';
import type { AlertItem, DeviceCfg, PingResult, RadioStatus, Station, Thresholds } from '../src/core/types';

const th: Thresholds = { latencyMs: 40, lossPct: 5, backboneCcq: 90, backboneCapacity: 80, weakSignal: -75, apNoise: -80, sustainPolls: 2 };

describe('station send rates', () => {
  const last = (t: number, sent: number, recv: number, apId = 'ap1') => ({ t, apId, sent, recv, sentBytes: sent * 300 });
  it('turns running counters into packets a second', () => {
    expect(stationRate(last(0, 1000, 500), last(60000, 3700, 560))).toEqual({ t: 60000, sent: 45, recv: 1, bytes: 300 });
  });
  it('ignores a reconnect, a move to another AP, and readings too close or too far apart', () => {
    expect(stationRate(last(0, 5000, 500), last(60000, 100, 10))).toBeNull();
    expect(stationRate(last(0, 1000, 500), last(60000, 3000, 600, 'ap2'))).toBeNull();
    expect(stationRate(last(0, 1000, 500), last(2000, 1100, 510))).toBeNull();
    expect(stationRate(last(0, 1000, 500), last(3600000, 9000, 900))).toBeNull();
  });
  it('measures how closely two series move together', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(correlation(a, a.map((x) => x * 3 + 1))).toBe(1);
    expect(correlation(a, a.map((x) => -x))).toBe(-1);
    expect(correlation(a.slice(0, 5), a.slice(0, 5))).toBeNull();
    expect(correlation(a, a.map(() => 4))).toBeNull();
  });
  it('flags a device that sends far more than it gets back, but not a busy normal one', () => {
    expect(suspectReason(45, 1, null)).toContain('broadcasting');
    expect(suspectReason(60, 40, null)).toBeNull();
    expect(suspectReason(12, 10, 0.8)).toContain('rises and falls with the flood');
    expect(suspectReason(3, 0, 0.9)).toBeNull();
  });
});

describe('TalkerTracker', () => {
  const sta = (mac: string, sent: number, recv: number): Station => ({
    mac, name: '', ip: '192.168.2.' + mac.length, signal: -70, noise: -90, ccq: 80, txRate: 65, rxRate: 65, latency: null, uptime: 100, distanceM: null,
    sentPkts: sent, sentBytes: sent * 400, recvPkts: recv,
  });
  it('picks out the device whose sending follows the flood, and names it from UDR3', () => {
    const tr = new TalkerTracker();
    const counts = { fire: 0, phone: 0, phoneRecv: 0, fireRecv: 0 };
    for (let i = 0; i <= 20; i++) {
      const t = i * 60000;
      const floodNow = 40 + (i % 5) * 30; // rises and falls
      if (i > 0) {
        counts.fire += floodNow * 60 * 0.8;
        counts.fireRecv += 30;
        counts.phone += 8 * 60;
        counts.phoneRecv += 40 * 60;
      }
      tr.update('ap1', 'Lookout AP#1', [sta('14:91:38:86:C9:D1', counts.fire, counts.fireRecv), sta('AA:00:00:00:00:01', counts.phone, counts.phoneRecv)], t);
      if (i > 0) tr.recordFlood(t, floodNow);
    }
    const info = clientInfo([{ mac: '14:91:38:86:c9:d1', hostname: 'Fire-TV', oui: 'Amazon Technologies Inc.', ip: '192.168.2.19' }]);
    const list = tr.talkers((m) => info.get(m));
    expect(list[0].mac).toBe('14:91:38:86:C9:D1');
    expect(list[0].name).toBe('Fire-TV');
    expect(list[0].vendor).toBe('Amazon Technologies Inc.');
    expect(list[0].floodMatch).toBeGreaterThan(0.9);
    expect(list[0].suspect).toContain('rises and falls');
    expect(list[1].suspect).toBeNull();
  });
});

describe('advice names the flood suspects', () => {
  it('lists the likely device in the flood fix and raises a broadcasting suggestion', () => {
    const talker = {
      mac: '14:91:38:86:C9:D1', ip: '192.168.2.19', name: 'Fire-TV', vendor: 'Amazon', apId: 'ap1', apName: 'Lookout AP#1', signal: -80,
      sentPps: 45, sentPeakPps: 60, recvPps: 1, avgBytes: 1400, floodMatch: 0.9, minutes: 30, suspect: 'It sends 45 packets a second.',
    };
    const watch = { idx: 2, name: 'L&M', downMbps: 1, upMbps: 1, downPeak: 1, upPeak: 1, readings: 4, floodPps: 220, floodPeakPps: 300, floodFromGatewayPps: 2 };
    const s = advise({
      devices: [], chain: [], events: [], thresholds: th, now: 1, talkers: [talker],
      gateway: { id: 'gw:u', name: 'UDR3', stats: { name: '', model: '', uptime: 1, cpu: 1, mem: 1, wanLatency: 11, wanUp: true, wanDownMbps: 1, wanUpMbps: 1, ports: [], networks: [], watch }, peakDown95: null, peakUp95: null, samples: 0, capacity: 60 },
    });
    expect(s.find((x) => x.id === 'flood:gw:u')!.fix).toContain('Fire-TV, Amazon (14:91:38:86:C9:D1, 192.168.2.19) on Lookout AP#1');
    expect(s.find((x) => x.id === 'talker:14:91:38:86:C9:D1')!.title).toBe('Fire-TV, Amazon keeps broadcasting');
  });
});

describe('per-reply ping parsing', () => {
  it('reads Windows output in order, with timeouts as gaps', () => {
    const out = [
      'Pinging 192.168.2.22 with 32 bytes of data:',
      'Reply from 192.168.2.22: bytes=32 time=26ms TTL=64',
      'Request timed out.',
      'Reply from 192.168.2.22: bytes=32 time<1ms TTL=64',
      'Reply from 192.168.2.1: Destination host unreachable.',
    ].join('\r\n');
    expect(parsePingSeries(out, 5)).toEqual([26, null, 1, null, null]);
  });
  it('places Linux replies by sequence number', () => {
    const out = ['64 bytes from 10.0.0.1: icmp_seq=1 ttl=64 time=8.1 ms', '64 bytes from 10.0.0.1: icmp_seq=3 ttl=64 time=9.4 ms'].join('\n');
    expect(parsePingSeries(out, 4)).toEqual([8.1, null, 9.4, null]);
  });
});

const steady = (ms: number, n = 30) => Array.from({ length: n }, () => ms);
const withSpikes = (ms: number, at: number[], add = 200, n = 30) => Array.from({ length: n }, (_, i) => (at.includes(i) ? ms + add : ms));
const radio = (p: Partial<RadioStatus>) => ({ hostname: '', model: '', firmware: '', uptime: 1, mode: 'sta', wds: true, essid: '', frequency: 5800, channel: 160, channelWidth: 20, signal: -53, noise: -85, ccq: 98, txRate: 130, rxRate: 130, txPower: 20, airmaxQuality: 95, airmaxCapacity: 95, stationCount: 1, cpu: 5, memPct: 50, lanSpeed: 100, security: '', ...p }) as RadioStatus;

describe('path test analysis', () => {
  const spikes = [3, 7, 12, 18, 25];
  it('blames the link where spikes start and carry through, and calls it interference when traffic is light and figures healthy', () => {
    const r = analyseTrace({
      hops: [
        { id: 'h', name: 'House sender', role: 'backbone-ap', series: steady(4) },
        { id: 'l', name: 'Lookout sender', role: 'backbone-ap', series: steady(9) },
        { id: 'm', name: 'Mast 2 station', role: 'backbone-sta', series: withSpikes(15, spikes), radio: radio({}) },
        { id: 'k', name: 'Monks station', role: 'backbone-sta', series: withSpikes(20, spikes) },
      ],
      backboneMbps: 3,
      capacity: 60,
      floodPps: 80,
    });
    expect(r.culprit).toBe(2);
    expect(r.hops[2].spikesStartHere).toBe(5);
    expect(r.hops[2].addedMedian).toBe(6);
    expect(r.verdict).toContain('link from Lookout sender to Mast 2 station');
    expect(r.verdict).toContain('waiting for clear air');
  });
  it('calls it congestion when the backbone is near full', () => {
    const r = analyseTrace({
      hops: [
        { id: 'h', name: 'House', role: 'backbone-ap', series: steady(4) },
        { id: 'm', name: 'Mast 2', role: 'backbone-sta', series: withSpikes(15, spikes), radio: radio({}) },
      ],
      backboneMbps: 50,
      capacity: 60,
      floodPps: null,
    });
    expect(r.verdict).toContain('congestion');
  });
  it('does not blame a radio that is only slow to answer ping itself', () => {
    const r = analyseTrace({
      hops: [
        { id: 'h', name: 'House', role: 'backbone-ap', series: steady(4) },
        { id: 'm', name: 'Mast 2', role: 'backbone-sta', series: withSpikes(15, spikes) },
        { id: 'k', name: 'Monks', role: 'backbone-sta', series: steady(20) },
      ],
      backboneMbps: 3,
      capacity: 60,
      floodPps: null,
    });
    expect(r.spikes).toBe(0);
    expect(r.verdict).toContain('No real delay spikes');
  });
  it('points at this PC when spikes start at the first radio, and at the AP when only it spikes', () => {
    const pc = analyseTrace({
      hops: [
        { id: 'h', name: 'House', role: 'backbone-ap', series: withSpikes(4, spikes) },
        { id: 'm', name: 'Mast 2', role: 'backbone-sta', series: withSpikes(15, spikes) },
      ],
      backboneMbps: 3, capacity: 60, floodPps: null,
    });
    expect(pc.culprit).toBe(0);
    expect(pc.verdict).toContain('this PC');
    const ap = analyseTrace({
      hops: [
        { id: 'h', name: 'House', role: 'backbone-ap', series: steady(4) },
        { id: 'a', name: 'Monks AP#1', role: 'ap', series: withSpikes(25, spikes), clients: 4, weakest: -82 },
      ],
      backboneMbps: 3, capacity: 60, floodPps: null,
    });
    expect(ap.verdict).toContain('only at Monks AP#1');
    expect(ap.verdict).toContain('4 devices, weakest at -82 dBm');
  });
  it('treats lost replies as spikes', () => {
    const lossy = steady(15).map((v, i) => (spikes.includes(i) ? null : v));
    const r = analyseTrace({
      hops: [
        { id: 'h', name: 'House', role: 'backbone-ap', series: steady(4) },
        { id: 'm', name: 'Mast 2', role: 'backbone-sta', series: lossy },
      ],
      backboneMbps: null, capacity: 60, floodPps: null,
    });
    expect(r.culprit).toBe(1);
    expect(r.hops[1].lossPct).toBe(17);
  });
});

describe('hop-aware slow alerts', () => {
  const devs: DeviceCfg[] = [
    { id: 'house', name: 'House', ip: '1', site: 'House', role: 'auto', enabled: true },
    { id: 'look', name: 'Lookout station', ip: '2', site: 'Lookout', role: 'auto', enabled: true },
    { id: 'mast', name: 'Mast 2 station', ip: '3', site: 'Mast 2', role: 'auto', enabled: true },
    { id: 'ap5', name: 'AP#5', ip: '4', site: 'Mast 2', role: 'auto', enabled: true },
  ];
  const chain = ['house', 'look', 'mast'];
  it('finds the radio each one hangs off', () => {
    expect(parentOf('house', devs, chain)).toBeNull();
    expect(parentOf('mast', devs, chain)).toBe('look');
    expect(parentOf('ap5', devs, chain)).toBe('mast');
  });
  const p = (avg: number, loss = 0): PingResult => ({ sent: 5, received: 5, lossPct: loss, avg, min: avg, max: avg });
  function run(apAvg: number, mastAvg: number, apLoss = 0, mastLoss = 0) {
    const raised: AlertItem[] = [];
    const e = new AlertEngine({ raised: (a) => raised.push(a), resolved: () => undefined, event: () => undefined });
    for (let t = 1; t <= 3; t++) {
      e.evaluate(devs[2], 'backbone-sta', { t, id: 'mast', ping: p(mastAvg, mastLoss) }, undefined, th, undefined, false, { name: 'Lookout station', ping: p(9) });
      e.evaluate(devs[3], 'ap', { t, id: 'ap5', ping: p(apAvg, apLoss) }, undefined, th, undefined, false, { name: 'Mast 2 station', ping: p(mastAvg, mastLoss) });
    }
    return raised;
  }
  it('alerts once, on the hop that adds the delay, not on every radio past it', () => {
    const r = run(75, 70);
    expect(r.map((a) => a.key)).toEqual(['mast:latency']);
    expect(r[0].detail).toContain('61 ms of that is added after Lookout station');
  });
  it('still alerts on an AP that adds delay itself', () => {
    expect(run(80, 15).map((a) => a.key)).toEqual(['ap5:latency']);
  });
  it('blames loss on the first radio that loses packets', () => {
    expect(run(20, 15, 22, 20).map((a) => a.key)).toEqual(['mast:loss']);
  });
});
