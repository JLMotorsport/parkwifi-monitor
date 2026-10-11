// Finds which devices on the access points send the most, and which of them rise and fall with
// the broadcast flood UDR3 sees. airOS keeps running packet counters for every connected device,
// so the rate each device sends at falls out of two readings a minute apart. Pure apart from the
// in-memory history; no extra load on the radios.
import type { Station, Talker } from './types';

interface Point {
  t: number;
  sent: number;
  recv: number;
  bytes: number | null;
}
interface Track {
  apId: string;
  apName: string;
  ip: string;
  signal: number | null;
  points: Point[];
}
interface Last {
  t: number;
  apId: string;
  sent: number;
  recv: number;
  sentBytes: number | null;
}

/** Packets a second sent and received between two readings of the same association; null if they can't be compared. */
export function stationRate(prev: Last | undefined, cur: Last): Point | null {
  if (!prev || prev.apId !== cur.apId) return null;
  const dt = (cur.t - prev.t) / 1000;
  // counters restart when a device reconnects; a gap over 10 minutes is too coarse to be useful
  if (dt < 5 || dt > 600 || cur.sent < prev.sent || cur.recv < prev.recv) return null;
  const sent = (cur.sent - prev.sent) / dt;
  const bytes = cur.sentBytes !== null && prev.sentBytes !== null && cur.sent > prev.sent ? Math.round((cur.sentBytes - prev.sentBytes) / (cur.sent - prev.sent)) : null;
  return { t: cur.t, sent: Math.round(sent * 10) / 10, recv: Math.round(((cur.recv - prev.recv) / dt) * 10) / 10, bytes: bytes !== null && bytes >= 0 ? bytes : null };
}

/** Pearson correlation; null when there is too little to go on or one side never changes. */
export function correlation(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 10) return null;
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx < 1e-9 || syy < 1e-9) return null;
  return Math.round((sxy / Math.sqrt(sxx * syy)) * 100) / 100;
}

/** Thresholds for calling a device a likely flood source. */
export const SUSPECT_PPS = 20;
export const SUSPECT_RATIO = 3;
export const SUSPECT_MATCH = 0.6;

export function suspectReason(sentPps: number, recvPps: number, match: number | null): string | null {
  const reasons: string[] = [];
  if (sentPps >= SUSPECT_PPS && sentPps >= SUSPECT_RATIO * Math.max(recvPps, 0.5)) {
    reasons.push(`it sends ${sentPps} packets a second but gets back only ${recvPps}, so it is broadcasting (or streaming out, like a camera) rather than browsing`);
  }
  if (match !== null && match >= SUSPECT_MATCH && sentPps >= SUSPECT_PPS / 2) {
    reasons.push(`its sending rises and falls with the flood on UDR3 (${Math.round(match * 100)}% match)`);
  }
  if (!reasons.length) return null;
  const s = reasons.join(', and ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

export class TalkerTracker {
  private last = new Map<string, Last>();
  private tracks = new Map<string, Track>();
  private flood = new Map<number, number>();

  constructor(private windowMs = 2 * 3600_000) {}

  /** Feed one poll of an access point's connected devices. */
  update(apId: string, apName: string, stations: Station[], t: number) {
    for (const s of stations) {
      if (s.sentPkts == null || s.recvPkts == null) continue;
      const cur: Last = { t, apId, sent: s.sentPkts, recv: s.recvPkts, sentBytes: s.sentBytes ?? null };
      const p = stationRate(this.last.get(s.mac), cur);
      this.last.set(s.mac, cur);
      let tr = this.tracks.get(s.mac);
      if (!tr || tr.apId !== apId) {
        // a device that moved to another AP starts a fresh track there
        tr = { apId, apName, ip: s.ip, signal: s.signal, points: tr?.points ?? [] };
        this.tracks.set(s.mac, tr);
      }
      tr.apId = apId;
      tr.apName = apName;
      tr.ip = s.ip || tr.ip;
      tr.signal = s.signal;
      if (p) tr.points.push(p);
    }
    this.prune(t);
  }

  /** Broadcast + multicast packets/s arriving at UDR3 from the radios, at the same poll time. */
  recordFlood(t: number, pps: number | null | undefined) {
    if (pps != null && Number.isFinite(pps)) this.flood.set(t, pps);
    this.prune(t);
  }

  private prune(now: number) {
    const cut = now - this.windowMs;
    for (const [mac, tr] of this.tracks) {
      tr.points = tr.points.filter((p) => p.t >= cut);
      const l = this.last.get(mac);
      if (!tr.points.length && (!l || l.t < cut)) {
        this.tracks.delete(mac);
        this.last.delete(mac);
      }
    }
    for (const t of this.flood.keys()) if (t < cut) this.flood.delete(t);
  }

  talkers(info: (mac: string) => { name: string; vendor: string; ip?: string } | undefined, limit = 12): Talker[] {
    const out: Talker[] = [];
    for (const [mac, tr] of this.tracks) {
      if (tr.points.length < 2) continue;
      const avg = (xs: number[]) => Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10;
      const sent = tr.points.map((p) => p.sent);
      const bytes = tr.points.map((p) => p.bytes).filter((b): b is number => b !== null);
      const paired = tr.points.filter((p) => this.flood.has(p.t));
      const match = correlation(
        paired.map((p) => p.sent),
        paired.map((p) => this.flood.get(p.t)!),
      );
      const sentPps = avg(sent);
      const recvPps = avg(tr.points.map((p) => p.recv));
      const i = info(mac);
      out.push({
        mac,
        ip: tr.ip || i?.ip || '',
        name: i?.name ?? '',
        vendor: i?.vendor ?? '',
        apId: tr.apId,
        apName: tr.apName,
        signal: tr.signal,
        sentPps,
        sentPeakPps: Math.max(...sent),
        recvPps,
        avgBytes: bytes.length ? Math.round(bytes.reduce((a, b) => a + b, 0) / bytes.length) : null,
        floodMatch: match,
        minutes: tr.points.length,
        suspect: suspectReason(sentPps, recvPps, match),
      });
    }
    return out.sort((a, b) => Number(!!b.suspect) - Number(!!a.suspect) || b.sentPps - a.sentPps).slice(0, limit);
  }
}
