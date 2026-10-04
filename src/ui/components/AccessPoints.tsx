import type { AppState } from '../../core/types';
import { duration, n } from '../format';
import { Pill } from './Pill';

export function AccessPoints({ s, open }: { s: AppState; open: (id: string) => void }) {
  const aps = s.devices
    .filter((d) => d.cfg.enabled && (d.role === 'ap' || (d.role === 'unknown' && !s.chain.includes(d.cfg.id))))
    .sort((a, b) => (b.latest?.stations?.weak ?? 0) - (a.latest?.stations?.weak ?? 0));
  return (
    <div className="card">
      <div className="card-h">
        <h2>Access points</h2>
        <span className="sub">Sorted by devices on a weak signal. Click a row for its device list and history.</span>
      </div>
      <div className="card-b tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Status</th>
              <th>Name</th>
              <th>Site</th>
              <th className="r">Channel</th>
              <th className="r">Power</th>
              <th className="r">Noise</th>
              <th className="r">Devices</th>
              <th className="r">Weak</th>
              <th className="r">No IP</th>
              <th className="r">Avg signal</th>
              <th className="r">CCQ</th>
              <th className="r">Ping</th>
              <th className="r">Up</th>
            </tr>
          </thead>
          <tbody>
            {aps.map((d) => {
              const r = d.latest?.radio;
              const st = d.latest?.stations;
              return (
                <tr key={d.cfg.id} className="click" onClick={() => open(d.cfg.id)}>
                  <td>
                    <Pill h={d.health} />
                  </td>
                  <td>
                    <b>{d.cfg.name}</b>
                  </td>
                  <td>{d.cfg.site}</td>
                  <td className="r">{r ? `${n(r.channel)} (${n(r.frequency)})` : '–'}</td>
                  <td className="r">{n(r?.txPower, ' dBm')}</td>
                  <td className="r">{n(r?.noise, ' dBm')}</td>
                  <td className="r">{st?.count ?? '–'}</td>
                  <td className={`r ${st?.weak ? 'weak' : ''}`}>{st?.weak ?? '–'}</td>
                  <td className={`r ${st?.noIp ? 'weak' : ''}`}>{st?.noIp ?? '–'}</td>
                  <td className="r">{n(st?.avgSignal, ' dBm')}</td>
                  <td className="r">{n(r?.ccq, '%', 1)}</td>
                  <td className="r">{n(d.latest?.ping.avg, ' ms')}</td>
                  <td className="r">{duration(r?.uptime)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!aps.length && <div className="empty">No access points found yet. Use Discover radios in Settings.</div>}
      </div>
    </div>
  );
}
