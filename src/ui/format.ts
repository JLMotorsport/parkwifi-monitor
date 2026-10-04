export const n = (v: number | null | undefined, unit = '', digits = 0) =>
  v === null || v === undefined || Number.isNaN(v) ? '–' : `${v.toFixed(digits)}${unit}`;

export function ago(t: number | null | undefined, now = Date.now()) {
  if (!t) return 'never';
  const s = Math.round((now - t) / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function duration(sec: number | null | undefined) {
  if (sec === null || sec === undefined) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

export const clock = (t: number) =>
  new Date(t).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }).replace(',', '');

/** Signal quality bucket used everywhere a dBm number is shown. */
export function sigClass(dbm: number | null | undefined, weak = -75): 'good' | 'warning' | 'critical' | 'unknown' {
  if (dbm === null || dbm === undefined) return 'unknown';
  if (dbm >= -65) return 'good';
  if (dbm > weak) return 'warning';
  return 'critical';
}

export const roleLabel: Record<string, string> = {
  'backbone-ap': 'Backbone sender',
  'backbone-sta': 'Backbone receiver',
  ap: 'Access point',
  unknown: 'Radio',
};
