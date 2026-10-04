import { describe, expect, it } from 'vitest';
import { parsePing } from '../src/core/ping';
import { parseStations, parseStatus } from '../src/core/airos';
import { AlertEngine } from '../src/core/alerts';
import { defaultConfig } from '../src/core/config';
import type { AlertItem, Sample } from '../src/core/types';

describe('parsePing', () => {
  it('reads Windows output and ignores unreachable replies', () => {
    const out = [
      'Pinging 192.168.2.24 with 1400 bytes of data:',
      'Reply from 192.168.2.24: bytes=1400 time=7ms TTL=64',
      'Reply from 192.168.2.24: bytes=1400 time<1ms TTL=64',
      'Request timed out.',
      'Reply from 192.168.3.1: Destination host unreachable.',
      'Reply from 192.168.2.24: bytes=1400 time=442ms TTL=64',
    ].join('\r\n');
    const r = parsePing(out, 5);
    expect(r.received).toBe(3);
    expect(r.lossPct).toBe(40);
    expect(r.max).toBe(442);
    expect(r.min).toBe(1);
  });

  it('reads Linux output', () => {
    const out = '1408 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=13.2 ms\n1408 bytes from 8.8.8.8: icmp_seq=2 ttl=117 time=14.8 ms\n';
    const r = parsePing(out, 2);
    expect(r.avg).toBe(14);
    expect(r.lossPct).toBe(0);
  });

  it('treats no output as total loss', () => {
    expect(parsePing('', 5)).toMatchObject({ received: 0, lossPct: 100, avg: null });
  });
});

describe('parseStatus', () => {
  it('normalises an airOS 6 station status', () => {
    const s = parseStatus({
      host: { hostname: 'Lookout-Lookout Station (73L)', devmodel: 'NanoStation M5', fwversion: 'XM.v6.3.16', uptime: 5130000, totalram: 30000, freeram: 5400 },
      wireless: { mode: 'sta', wds: 1, frequency: '5800 MHz', channel: 160, signal: -53, noisef: -85, ccq: 991, txrate: '52.0', rxrate: '130.0', polling: { quality: 99, capacity: 98 } },
      interfaces: [{ ifname: 'eth0', status: { speed: 100 } }],
    });
    expect(s.ccq).toBe(99.1);
    expect(s.frequency).toBe(5800);
    expect(s.txRate).toBe(52);
    expect(s.airmaxCapacity).toBe(98);
    expect(s.memPct).toBe(82);
    expect(s.wds).toBe(true);
  });

  it('normalises a station list', () => {
    const st = parseStations([{ mac: '9a:0e:4e:5b:84:e5', lastip: '192.168.2.150', signal: -75, ccq: 52, tx: 26, rx: 19.5, txlatency: 209, uptime: 120 }]);
    expect(st[0]).toMatchObject({ mac: '9A:0E:4E:5B:84:E5', ip: '192.168.2.150', signal: -75, ccq: 52, rxRate: 19.5 });
  });
});

describe('AlertEngine', () => {
  const th = defaultConfig().thresholds;
  const cfg = { id: 'ap7', name: 'Lookout AP#7', ip: '1.1.1.1', site: 'Mast 2', role: 'auto' as const, enabled: true };
  const mk = (t: number, avg: number | null, received = 5, uptime = 1000): Sample => ({
    t,
    id: 'ap7',
    ping: { sent: 5, received, lossPct: ((5 - received) / 5) * 100, avg, min: avg, max: avg },
    radio: received ? ({ uptime, frequency: 2457, mode: 'ap', wds: false, noise: -90 } as Sample['radio']) : undefined,
  });

  it('raises only after the condition persists, and clears on the first good poll', () => {
    const raised: AlertItem[] = [];
    const resolved: AlertItem[] = [];
    const e = new AlertEngine({ raised: (a) => raised.push(a), resolved: (a) => resolved.push(a), event: () => undefined });
    e.evaluate(cfg, 'ap', mk(1, 80), undefined, th);
    e.evaluate(cfg, 'ap', mk(2, 80), undefined, th);
    expect(raised).toHaveLength(0);
    e.evaluate(cfg, 'ap', mk(3, 80), undefined, th);
    expect(raised.map((a) => a.key)).toEqual(['ap7:latency']);
    e.evaluate(cfg, 'ap', mk(4, 5), undefined, th);
    expect(resolved).toHaveLength(1);
    expect(e.active.size).toBe(0);
  });

  it('logs a restart when uptime goes backwards', () => {
    const events: AlertItem[] = [];
    const e = new AlertEngine({ raised: () => undefined, resolved: () => undefined, event: (a) => events.push(a) });
    e.evaluate(cfg, 'ap', mk(2, 5, 5, 240), mk(1, 5, 5, 86400), th);
    expect(events[0].title).toContain('restarted');
  });

  it('marks a device down after two silent polls', () => {
    const raised: AlertItem[] = [];
    const e = new AlertEngine({ raised: (a) => raised.push(a), resolved: () => undefined, event: () => undefined });
    e.evaluate(cfg, 'ap', mk(1, null, 0), undefined, th);
    e.evaluate(cfg, 'ap', mk(2, null, 0), undefined, th);
    expect(raised[0]).toMatchObject({ key: 'ap7:offline', severity: 'critical' });
  });
});
