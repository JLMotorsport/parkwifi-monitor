import { Icon } from './Icon';

export type Health = 'good' | 'warning' | 'serious' | 'critical' | 'unknown';

export const HEALTH_LABEL: Record<Health, string> = {
  good: 'OK',
  warning: 'Warning',
  serious: 'Problem',
  critical: 'Down',
  unknown: 'No data',
};

/** Small status glyph: shape differs per state so it reads without colour. */
export function StatusIcon({ h, size = 12 }: { h: Health; size?: number }) {
  if (h === 'good') return <Icon name="check" size={size} stroke={3} />;
  if (h === 'critical') return <Icon name="close" size={size} stroke={3} />;
  if (h === 'unknown') return <Icon name="circle" size={size - 4} />;
  return <Icon name="triangle" size={size} />;
}

/** Status is always icon + word + colour, never colour alone. */
export function Pill({ h, label }: { h: Health; label?: string }) {
  return (
    <span className={`pill ${h}`}>
      <StatusIcon h={h} />
      {label ?? HEALTH_LABEL[h]}
    </span>
  );
}

export function worst(hs: Health[]): Health {
  const rank: Record<Health, number> = { unknown: -1, good: 0, warning: 1, serious: 2, critical: 3 };
  let w: Health = hs.length ? 'good' : 'unknown';
  for (const h of hs) if (rank[h] > rank[w]) w = h;
  return w;
}
