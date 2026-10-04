import type { AlertItem, AppState } from '../../core/types';
import { eventKind } from '../derive';
import { ago, clock } from '../format';
import { Icon } from './Icon';

function AlertIcon({ a }: { a: AlertItem }) {
  if (a.event) {
    const k = eventKind(a.key);
    return <Icon name={k === 'channel' ? 'swap' : 'restart'} size={18} stroke={2} className="ic" color="var(--text-2)" />;
  }
  if (a.resolvedAt) return <Icon name="check" size={18} stroke={2.4} className="ic" color="var(--good)" />;
  const c = a.severity === 'critical' ? 'var(--critical)' : a.severity === 'serious' ? 'var(--serious)' : 'var(--warning)';
  return <Icon name="triangle" size={18} className="ic" color={c} />;
}

const SEV: Record<string, string> = { warning: 'Warning', serious: 'Problem', critical: 'Down' };

export function AlertList({ items, now, open, empty, limit }: { items: AlertItem[]; now: number; open: (id: string) => void; empty: string; limit?: number }) {
  if (!items.length) return <div className="empty">{empty}</div>;
  const shown = limit ? items.slice(0, limit) : items;
  return (
    <div className="alist">
      {shown.map((a, i) => {
        const cleared = !!a.resolvedAt && !a.event;
        const when = cleared
          ? `${clock(a.resolvedAt!)} · cleared after ${Math.max(1, Math.round((a.resolvedAt! - a.startedAt) / 60000))} min`
          : a.event
            ? clock(a.startedAt)
            : `${clock(a.startedAt)} · ${ago(a.startedAt, now)}`;
        return (
          <button className="arow" key={a.key + i} onClick={() => open(a.deviceId)}>
            <AlertIcon a={a} />
            <div style={{ minWidth: 0 }}>
              <div className="t">
                {a.title}
                <span className={`tag ${cleared ? 'ink-good' : a.event ? 'ink-unknown' : 'ink-' + a.severity}`}>
                  {cleared ? 'Cleared' : a.event ? 'Event' : SEV[a.severity]}
                </span>
              </div>
              <div className="d">{a.detail}</div>
              <div className="when">{when}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function AlertsPage({ s, open }: { s: AppState; open: (id: string) => void }) {
  return (
    <div className="row2">
      <section className="card" style={{ flex: '1 1 420px' }}>
        <div className="card-h">
          <h2>Active</h2>
          <span className="sub">Raised after several bad polls in a row; cleared on the first good one.</span>
        </div>
        <AlertList items={s.alerts} now={s.now} open={open} empty="Nothing wrong right now." />
      </section>
      <section className="card" style={{ flex: '2 1 560px' }}>
        <div className="card-h">
          <h2>History</h2>
          <span className="sub">Alerts, clears, restarts and channel changes, newest first</span>
        </div>
        <AlertList items={s.events} now={s.now} open={open} empty="No history yet." />
      </section>
    </div>
  );
}
