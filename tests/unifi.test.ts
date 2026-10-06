import { describe, expect, it } from 'vitest';
import { parseStats, pickWatchPort, rate, readCounters } from '../src/core/unifi';

const dev = (rx: number, tx: number, wrx: number, wtx: number) => ({
  type: 'udm',
  model: 'UDR',
  name: 'UDR3',
  uptime: 1000,
  'system-stats': { cpu: '12.5', mem: '61' },
  port_table: [
    { port_idx: 1, name: 'Port 1', up: true, speed: 1000, rx_bytes: 10, tx_bytes: 10 },
    { port_idx: 3, name: 'Lookout&Monks', up: true, speed: 100, rx_bytes: rx, tx_bytes: tx, 'rx_bytes-r': 125000, 'tx_bytes-r': 1250000 },
  ],
  wan1: { rx_bytes: wrx, tx_bytes: wtx },
});
const raw = (d: object) => ({
  health: [
    { subsystem: 'www', latency: 14, status: 'ok' },
    { subsystem: 'wan', 'rx_bytes-r': 2500000, 'tx_bytes-r': 250000 },
  ],
  devices: [{ type: 'uap' }, d],
  networks: [
    { _id: 'n1', name: 'Lookout&Monks', purpose: 'corporate', ip_subnet: '192.168.2.1/24', dhcpd_enabled: true, dhcpd_start: '192.168.2.100', dhcpd_stop: '192.168.2.199', dhcpd_leasetime: 86400 },
    { _id: 'w', name: 'WAN', purpose: 'wan' },
  ],
  clients: [{ network_id: 'n1' }, { network_id: 'n1' }, { network_id: 'other' }],
});

describe('unifi parsing', () => {
  it('works out port rates from byte counters', () => {
    const a = readCounters(dev(0, 0, 0, 0), 0);
    const b = readCounters(dev(1_250_000, 12_500_000, 0, 0), 10_000);
    expect(rate(a, b, 3, 'tx')).toBe(10);
    expect(rate(a, b, 3, 'rx')).toBe(1);
  });
  it('ignores a counter that went backwards (gateway restart)', () => {
    const a = readCounters(dev(5000, 5000, 0, 0), 0);
    const b = readCounters(dev(10, 10, 0, 0), 10_000);
    expect(rate(a, b, 3, 'tx')).toBeNull();
  });
  it('falls back to the gateway rate fields on the first reading', () => {
    const d = dev(0, 0, 0, 0);
    const s = parseStats(raw(d), undefined, readCounters(d, 0));
    const p = s.ports.find((x) => x.idx === 3)!;
    expect(p.txMbps).toBe(10);
    expect(p.rxMbps).toBe(1);
    expect(s.wanDownMbps).toBe(20);
    expect(s.wanLatency).toBe(14);
    expect(s.cpu).toBe(12.5);
  });
  it('counts clients and DHCP pool per network, skipping WAN', () => {
    const d = dev(0, 0, 0, 0);
    const s = parseStats(raw(d), undefined, readCounters(d, 0));
    expect(s.networks).toEqual([{ name: 'Lookout&Monks', subnet: '192.168.2.1/24', clients: 2, poolSize: 100, leaseSeconds: 86400 }]);
  });
  it('picks the radio port by name unless one is chosen', () => {
    const d = dev(0, 0, 0, 0);
    const s = parseStats(raw(d), undefined, readCounters(d, 0));
    expect(pickWatchPort(s.ports, null)?.idx).toBe(3);
    expect(pickWatchPort(s.ports, 1)?.idx).toBe(1);
  });
});
