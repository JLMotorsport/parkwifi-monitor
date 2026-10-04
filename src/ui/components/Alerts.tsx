import type { AlertItem, AppState } from '../../core/types';
import { ago, clock } from '../format';
import { Pill } from './Pill';

export function AlertList({ items, now, open, empty }: { items: AlertItem[]; now: number; open: (id: string) => void; empty: string }) {
  if (!items.length) return <div className="empty">{empty}</div>;
  return (
    <div>
      {items.map((a, i) => (
        <div className="alert-row" key={a.key + i} onClick={() => open(a.deviceId)} style={{ cursor: 'pointer' }}>
          <Pill h={a.resolvedAt && !a.event ? 'good' : a.severity} label={a.resolvedAt && !a.event ? 'Cleared' : a.event ? 'Event' : undefined} />
          <div>
            <div className="t">{a.title}</div>
            <div className="d">{a.detail}</div>
          </div>
          <div className="when">
            {clock(a.resolvedAt && !a.event ? a.resolvedAt : a.startedAt)}
            <br />
            {a.resolvedAt && !a.event
              ? `lasted ${Math.max(1, Math.round((a.resolvedAt - a.startedAt) / 60000))} min`
              : ago(a.startedAt, now)}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AlertsPage({ s, open }: { s: AppState; open: (id: string) => void }) {
  return (
    <>
      <div className="card">
        <div className="card-h">
          <h2>Active</h2>
          <span className="sub">Raised after the condition holds for several polls in a row; cleared on the first good poll.</span>
        </div>
        <div className="card-b">
          <AlertList items={s.alerts} now={s.now} open={open} empty="Nothing wrong right now." />
        </div>
      </div>
      <div className="card">
        <div className="card-h">
          <h2>History</h2>
          <span className="sub">Alerts, clears, restarts and channel changes, newest first</span>
        </div>
        <div className="card-b">
          <AlertList items={s.events} now={s.now} open={open} empty="No history yet." />
        </div>
      </div>
    </>
  );
}
