type Health = 'good' | 'warning' | 'serious' | 'critical' | 'unknown';

const LABEL: Record<Health, string> = {
  good: 'OK',
  warning: 'Warning',
  serious: 'Problem',
  critical: 'Down',
  unknown: 'No data',
};
const ICON: Record<Health, string> = { good: '✓', warning: '!', serious: '!', critical: '×', unknown: '?' };

/** Status is always icon + word + colour, never colour alone. */
export function Pill({ h, label }: { h: Health; label?: string }) {
  return (
    <span className={`pill ${h}`}>
      <span className="ic" aria-hidden>
        {ICON[h]}
      </span>
      {label ?? LABEL[h]}
    </span>
  );
}
