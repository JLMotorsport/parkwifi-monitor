import type { AppState, DeviceState, PingResult } from '../core/types';
import type { Health } from './components/Pill';

/** Customer-facing access points: anything not in the backbone chain that serves clients. */
export function accessPoints(s: AppState): DeviceState[] {
  return s.devices.filter((d) => d.cfg.enabled && (d.role === 'ap' || (d.role === 'unknown' && !s.chain.includes(d.cfg.id))));
}

export function chainDevices(s: AppState): DeviceState[] {
  const byId = new Map(s.devices.map((d) => [d.cfg.id, d]));
  return s.chain.map((id) => byId.get(id)).filter((d): d is DeviceState => !!d && d.cfg.enabled);
}

/**
 * Rough internet latency for a customer at this radio: its ping from this PC plus this PC's
 * internet ping. Both legs are measured from the office, so the office-to-UDR2 hop is counted
 * twice (about 1 ms). It cannot see a problem on UDR3's own route out.
 */
export function estInternet(s: AppState, d?: DeviceState | PingResult): { ms: number; lossPct: number } | null {
  const net = (s.probes.find((p) => p.probe.id === 'internet') ?? s.probes[0])?.latest?.ping;
  const p = d && 'sent' in d ? d : d?.latest?.ping;
  if (!net || !p || net.avg == null || p.avg == null || !net.received || !p.received) return null;
  return { ms: Math.round(p.avg + net.avg), lossPct: Math.round(100 - (100 - p.lossPct) * (100 - net.lossPct) / 100) };
}

export function probeHealth(p?: Pick<PingResult, 'received' | 'lossPct' | 'avg'>): Health {
  if (!p) return 'unknown';
  if (p.received === 0) return 'critical';
  if (p.lossPct > 40) return 'serious';
  if (p.lossPct > 20 || (p.avg ?? 0) > 60) return 'warning';
  return 'good';
}

/** Share of an AP's clients above the weak-signal line, 0-100, or null with no clients. */
export function goodShare(d: DeviceState): number | null {
  const st = d.latest?.stations;
  if (!st || !st.count) return null;
  return Math.round(((st.count - st.weak) / st.count) * 100);
}

export const shareHealth = (v: number | null): Health => (v === null ? 'unknown' : v < 40 ? 'critical' : v < 70 ? 'warning' : 'good');

/** Kind of a one-off event, from its key (`<device>:<kind>:<time>`). */
export const eventKind = (key: string) => key.split(':')[1] ?? '';

export type Theme = 'system' | 'light' | 'dark';

export function applyTheme(t: Theme) {
  if (t === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem('theme');
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export function saveTheme(t: Theme) {
  try {
    localStorage.setItem('theme', t);
  } catch {
    /* storage unavailable: theme still applies for this session */
  }
}
