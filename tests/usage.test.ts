import { describe, expect, it } from 'vitest';
import { categoryName, clientBytes, clientRates, dpiDelta, parseDpi, summariseMinute } from '../src/core/usage';

const nets = [
  { _id: 'n1', name: 'Lookout & Monks' },
  { _id: 'n2', name: 'Default' },
];

describe('clientBytes', () => {
  it('reads wireless and wired counters, names and networks', () => {
    const m = clientBytes(
      [
        { mac: 'aa:aa:aa:aa:aa:01', hostname: 'Jakes-PC', oui: 'Dell', ip: '192.168.5.20', network_id: 'n2', 'wired-tx_bytes': 5000, 'wired-rx_bytes': 700 },
        { mac: 'aa:aa:aa:aa:aa:02', name: 'Fire TV', ip: '192.168.2.19', network_id: 'n1', tx_bytes: 9000, rx_bytes: 100 },
        { mac: 'aa:aa:aa:aa:aa:03', ip: '192.168.2.50' },
      ],
      nets,
    );
    expect(m.get('AA:AA:AA:AA:AA:01')).toMatchObject({ name: 'Jakes-PC', vendor: 'Dell', network: 'Default', down: 5000, up: 700 });
    expect(m.get('AA:AA:AA:AA:AA:02')).toMatchObject({ name: 'Fire TV', network: 'Lookout & Monks', down: 9000 });
    expect(m.has('AA:AA:AA:AA:AA:03')).toBe(false);
  });
});

describe('clientRates', () => {
  const at = (down: number, up: number) => clientBytes([{ mac: 'aa:aa:aa:aa:aa:01', tx_bytes: down, rx_bytes: up, network_id: 'n2' }], nets);
  it('turns two readings into Mbps', () => {
    // 150 MB down in 15 s = 80 Mbps
    const r = clientRates(at(0, 0), at(150_000_000, 1_875_000), 15);
    expect(r[0]).toMatchObject({ downMbps: 80, upMbps: 1 });
  });
  it('skips a device whose counters went back (it reconnected)', () => {
    expect(clientRates(at(9e9, 9e9), at(100, 100), 15)).toEqual([]);
  });
});

describe('traffic identification', () => {
  it('sums bytes per category per device and reports what grew', () => {
    const before = parseDpi([{ mac: 'aa:aa:aa:aa:aa:01', by_app: [{ app: 5, cat: 14, rx_bytes: 1e6, tx_bytes: 0 }, { app: 2, cat: 13, rx_bytes: 5e5, tx_bytes: 5e5 }] }]);
    const after = parseDpi([{ mac: 'aa:aa:aa:aa:aa:01', by_app: [{ app: 5, cat: 14, rx_bytes: 701e6, tx_bytes: 0 }, { app: 2, cat: 13, rx_bytes: 6e5, tx_bytes: 5e5 }] }]);
    const d = dpiDelta(before.get('AA:AA:AA:AA:AA:01'), after.get('AA:AA:AA:AA:AA:01')!);
    expect(d).toEqual([
      { cat: 'Software and security updates', mb: 700 },
      { cat: 'Web browsing', mb: 0.1 },
    ]);
  });
  it('says nothing without an earlier reading, and names unknown categories plainly', () => {
    expect(dpiDelta(undefined, new Map([[4, 1e9]]))).toEqual([]);
    expect(categoryName(4)).toBe('Video and music streaming');
    expect(categoryName(99)).toBe('Category 99');
  });
});

describe('summariseMinute', () => {
  const r = (mac: string, name: string, down: number) => ({ mac, name, vendor: '', ip: '', network: 'Default', downMbps: down, upMbps: 0.5 });
  it('finds the devices behind the busiest moment and their share of it', () => {
    const m = summariseMinute([
      { t: 1, totalDown: 12, rates: [r('B', 'Fire TV', 8)] },
      { t: 2, totalDown: 115, rates: [r('A', 'Jakes-PC', 100), r('B', 'Fire TV', 9)] },
      { t: 3, totalDown: 20, rates: [r('A', 'Jakes-PC', 10), r('B', 'Fire TV', 8)] },
      { t: 4, totalDown: 10, rates: [r('B', 'Fire TV', 8)] },
    ]);
    expect(m.peak?.t).toBe(2);
    expect(m.peak?.totalDown).toBe(115);
    expect(m.peak?.clients[0]).toMatchObject({ name: 'Jakes-PC', downMbps: 100, share: 87 });
    // over the whole minute the PC averaged 27.5 Mbps and the TV 8.25
    expect(m.top.map((x) => [x.name, x.downMbps])).toEqual([
      ['Jakes-PC', 27.5],
      ['Fire TV', 8.25],
    ]);
  });
  it('handles an empty minute', () => {
    expect(summariseMinute([])).toEqual({ top: [], peak: null });
  });
});
