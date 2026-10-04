import type { AppState, Thresholds } from '../../core/types';
import { accessPoints } from '../derive';
import { duration, n } from '../format';
import { SignalBar } from './DeviceDetail';

/** Every client on every access point, weakest first. */
export function ClientsPage({ s, open, thresholds, weakOnly, query }: { s: AppState; open: (id: string) => void; thresholds: Thresholds | null; weakOnly: boolean; query: string }) {
  const weakLine = thresholds?.weakSignal ?? -75;
  const q = query.trim().toLowerCase();
  const rows = accessPoints(s)
    .flatMap((ap) => (ap.stationsLive ?? []).map((st) => ({ ap, st })))
    .filter(({ st }) => !weakOnly || (st.signal !== null && st.signal <= weakLine))
    .filter(({ ap, st }) => !q || st.mac.toLowerCase().includes(q) || st.ip.includes(q) || st.name.toLowerCase().includes(q) || ap.cfg.name.toLowerCase().includes(q))
    .sort((a, b) => (a.st.signal ?? -999) - (b.st.signal ?? -999));

  return (
    <section className="card tbl-wrap">
      <table style={{ minWidth: 760 }}>
        <thead>
          <tr>
            <th>Signal</th>
            <th>Device</th>
            <th>IP</th>
            <th>Access point</th>
            <th className="r">Down / up Mbps</th>
            <th className="r">CCQ</th>
            <th className="r">Latency</th>
            <th className="r">Distance</th>
            <th className="r">Connected</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ ap, st }) => (
            <tr key={ap.cfg.id + st.mac} className="click" onClick={() => open(ap.cfg.id)}>
              <td>
                <SignalBar dbm={st.signal} weak={weakLine} />
              </td>
              <td>
                <span className="mono">{st.mac}</span>
                {st.name && <div className="hint">{st.name}</div>}
              </td>
              <td className={`mono ${st.ip ? 'dim' : 'weak'}`}>{st.ip || 'none'}</td>
              <td>{ap.cfg.name}</td>
              <td className={`r ${(st.rxRate ?? 99) <= 6.5 ? 'weak' : ''}`}>
                {n(st.txRate, '', 1)} / {n(st.rxRate, '', 1)}
              </td>
              <td className="r dim">{n(st.ccq, '%')}</td>
              <td className="r dim">{n(st.latency, ' ms')}</td>
              <td className="r dim">{st.distanceM ? `${(st.distanceM / 1000).toFixed(1)} km` : '–'}</td>
              <td className="r dim">{duration(st.uptime)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">{weakOnly ? 'No clients on a weak signal.' : 'No clients connected, or the access points have not been read yet.'}</div>}
    </section>
  );
}
