// Who is using the internet connection, and for what. UDR3 keeps running byte counters for every
// device it routes; two readings 15 s apart give each device's speed. Its traffic identification
// (DPI) keeps byte counters per kind of traffic per device; two readings a minute apart say what a
// busy device was doing. No websites are recorded: only the kind of traffic, as UniFi classifies it.
import type { TopClient } from './types';

type O = Record<string, unknown>;
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export interface ClientBytes {
  mac: string;
  name: string;
  vendor: string;
  ip: string;
  network: string;
  /** running totals: to the device (its downloads) and from it */
  down: number;
  up: number;
}

/** Byte counters per device from UniFi's client list. Wired devices report under "wired-". */
export function clientBytes(clients: unknown[], networks: unknown[]): Map<string, ClientBytes> {
  const netName = new Map<string, string>();
  for (const n of networks as O[]) netName.set(str(n._id), str(n.name));
  const out = new Map<string, ClientBytes>();
  for (const c of clients as O[]) {
    const mac = str(c.mac).toUpperCase();
    if (!mac) continue;
    const pick = (a: string, b: string) => {
      const x = num(c[a]);
      const y = num(c[b]);
      return x === null && y === null ? null : Math.max(x ?? 0, y ?? 0);
    };
    // UniFi counts from the network's side: tx = sent to the device, rx = received from it
    const down = pick('tx_bytes', 'wired-tx_bytes');
    const up = pick('rx_bytes', 'wired-rx_bytes');
    if (down === null || up === null) continue;
    out.set(mac, {
      mac,
      name: str(c.name) || str(c.hostname),
      vendor: str(c.oui),
      ip: str(c.ip) || str(c.last_ip),
      network: netName.get(str(c.network_id)) || str(c.network),
      down,
      up,
    });
  }
  return out;
}

export interface ClientRate {
  mac: string;
  name: string;
  vendor: string;
  ip: string;
  network: string;
  downMbps: number;
  upMbps: number;
}

const mbps = (bytes: number, sec: number) => Math.round(((bytes * 8) / sec / 1e6) * 100) / 100;

/** Each device's speed between two readings. A counter that went backwards (reconnect) is skipped. */
export function clientRates(prev: Map<string, ClientBytes> | undefined, cur: Map<string, ClientBytes>, dtSec: number): ClientRate[] {
  if (!prev || dtSec <= 0) return [];
  const out: ClientRate[] = [];
  for (const [mac, c] of cur) {
    const p = prev.get(mac);
    if (!p || c.down < p.down || c.up < p.up) continue;
    const d = mbps(c.down - p.down, dtSec);
    const u = mbps(c.up - p.up, dtSec);
    if (d + u < 0.01) continue;
    out.push({ mac, name: c.name, vendor: c.vendor, ip: c.ip, network: c.network, downMbps: d, upMbps: u });
  }
  return out.sort((a, b) => b.downMbps + b.upMbps - (a.downMbps + a.upMbps));
}

/** UniFi traffic-identification categories (from the controller's category codes). */
export const DPI_CATEGORIES: Record<number, string> = {
  0: 'Instant messaging',
  1: 'Peer-to-peer file sharing',
  3: 'File transfer / downloads',
  4: 'Video and music streaming',
  5: 'Email and collaboration',
  6: 'Voice and video calls',
  7: 'Database',
  8: 'Games',
  9: 'Network management',
  10: 'Remote access',
  11: 'VPN / proxy',
  12: 'Stock market',
  13: 'Web browsing',
  14: 'Software and security updates',
  15: 'Web messaging',
  17: 'Business apps',
  18: 'Network protocols',
  19: 'Network protocols',
  20: 'Network protocols',
  23: 'Private protocol',
  24: 'Social media',
  255: 'Unidentified',
};
export const categoryName = (cat: number) => DPI_CATEGORIES[cat] ?? `Category ${cat}`;

/** Running bytes per traffic category, per device, from UniFi's stat/stadpi (by_app or by_cat). */
export function parseDpi(raw: unknown[]): Map<string, Map<number, number>> {
  const out = new Map<string, Map<number, number>>();
  for (const row of raw as O[]) {
    const mac = str(row.mac).toUpperCase();
    if (!mac) continue;
    const list = (Array.isArray(row.by_app) ? row.by_app : Array.isArray(row.by_cat) ? row.by_cat : []) as O[];
    const cats = out.get(mac) ?? new Map<number, number>();
    for (const e of list) {
      const cat = num(e.cat);
      if (cat === null) continue;
      cats.set(cat, (cats.get(cat) ?? 0) + (num(e.rx_bytes) ?? 0) + (num(e.tx_bytes) ?? 0));
    }
    out.set(mac, cats);
  }
  return out;
}

/** What a device's traffic was between two DPI readings, biggest first. */
export function dpiDelta(prev: Map<number, number> | undefined, cur: Map<number, number>): { cat: string; mb: number }[] {
  if (!prev) return [];
  const out: { cat: string; mb: number }[] = [];
  for (const [cat, bytes] of cur) {
    const d = bytes - (prev.get(cat) ?? 0);
    // counters restart when the device reconnects; ignore that minute rather than guess
    if (d <= 0) continue;
    out.push({ cat: categoryName(cat), mb: Math.round((d / 1e6) * 10) / 10 });
  }
  return out.filter((x) => x.mb >= 0.1).sort((a, b) => b.mb - a.mb);
}

export interface Reading {
  t: number;
  /** internet download at that moment (Mbps) */
  totalDown: number;
  rates: ClientRate[];
}

/**
 * Sum one minute of 15 s readings: the devices that moved the most data over the minute, and the
 * devices behind the busiest single reading (the spike itself), with their share of it.
 */
export function summariseMinute(readings: Reading[], limit = 5): { top: TopClient[]; peak: { t: number; totalDown: number; clients: TopClient[] } | null } {
  if (!readings.length) return { top: [], peak: null };
  const by = new Map<string, { r: ClientRate; down: number; up: number; peak: number; n: number }>();
  for (const rd of readings) {
    for (const r of rd.rates) {
      const e = by.get(r.mac) ?? { r, down: 0, up: 0, peak: 0, n: 0 };
      e.down += r.downMbps;
      e.up += r.upMbps;
      e.peak = Math.max(e.peak, r.downMbps + r.upMbps);
      e.n++;
      e.r = r;
      by.set(r.mac, e);
    }
  }
  const n = readings.length;
  const r2 = (x: number) => Math.round(x * 100) / 100;
  const top: TopClient[] = [...by.values()]
    .map((e) => ({ mac: e.r.mac, name: e.r.name, vendor: e.r.vendor, ip: e.r.ip, network: e.r.network, downMbps: r2(e.down / n), upMbps: r2(e.up / n), peakMbps: r2(e.peak) }))
    .sort((a, b) => b.downMbps + b.upMbps - (a.downMbps + a.upMbps))
    .slice(0, limit);
  const busiest = readings.reduce((b, x) => (x.totalDown > b.totalDown ? x : b));
  const clients: TopClient[] = busiest.rates.slice(0, 3).map((r) => ({
    mac: r.mac,
    name: r.name,
    vendor: r.vendor,
    ip: r.ip,
    network: r.network,
    downMbps: r.downMbps,
    upMbps: r.upMbps,
    peakMbps: r2(r.downMbps + r.upMbps),
    share: busiest.totalDown > 0 ? Math.min(100, Math.round((r.downMbps / busiest.totalDown) * 100)) : null,
  }));
  return { top, peak: { t: busiest.t, totalDown: r2(busiest.totalDown), clients } };
}
