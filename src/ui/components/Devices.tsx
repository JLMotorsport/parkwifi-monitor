import { useState } from 'react';
import type { AppState, Thresholds } from '../../core/types';
import { duration, n, roleLabel } from '../format';
import { DevicePanel, linkSummary } from './DeviceDetail';
import { Icon } from './Icon';
import { HEALTH_LABEL } from './Pill';

export type DevFilter = 'all' | 'backbone' | 'ap';

export function DevicesPage({
  s,
  sel,
  setSel,
  thresholds,
  filter,
  query,
}: {
  s: AppState;
  sel: string | null;
  setSel: (id: string | null) => void;
  thresholds: Thresholds | null;
  filter: DevFilter;
  query: string;
}) {
  const q = query.trim().toLowerCase();
  const order = (id: string) => {
    const i = s.chain.indexOf(id);
    return i < 0 ? 100 : i;
  };
  const rows = s.devices
    .filter((d) => d.cfg.enabled)
    .filter((d) => (filter === 'all' ? true : filter === 'ap' ? d.role === 'ap' : d.role === 'backbone-ap' || d.role === 'backbone-sta'))
    .filter((d) => !q || d.cfg.name.toLowerCase().includes(q) || d.cfg.ip.includes(q) || d.cfg.site.toLowerCase().includes(q))
    .sort((a, b) => order(a.cfg.id) - order(b.cfg.id) || a.cfg.ip.localeCompare(b.cfg.ip, undefined, { numeric: true }));

  return (
    <div className="devlayout">
      <section className="card tbl-wrap">
        <table style={{ minWidth: 640 }}>
          <thead>
            <tr>
              <th>Name</th>
              <th>Model</th>
              <th>IP</th>
              <th>Ping</th>
              <th>Link</th>
              <th className="r">Uptime</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => {
              const slow = (d.latest?.ping.avg ?? 0) > (thresholds?.latencyMs ?? 40);
              const down = d.latest && d.latest.ping.received === 0;
              return (
                <tr key={d.cfg.id} className={`click ${sel === d.cfg.id ? 'sel' : ''}`} onClick={() => setSel(sel === d.cfg.id ? null : d.cfg.id)}>
                  <td>
                    <span className="namecell">
                      <span className={`sdot ${d.health}`} title={HEALTH_LABEL[d.health]} />
                      <span>
                        <b>{d.cfg.name}</b>
                        <small>
                          {roleLabel[d.role]} · {d.cfg.site}
                        </small>
                      </span>
                    </span>
                  </td>
                  <td className="dim">{d.latest?.radio?.model || '–'}</td>
                  <td className="mono dim">{d.cfg.ip}</td>
                  <td className={down || slow ? 'weak' : ''} style={{ fontWeight: 600 }}>
                    {down ? 'no reply' : n(d.latest?.ping.avg, ' ms')}
                  </td>
                  <td className={d.latest?.error ? 'weak' : 'dim'}>{linkSummary(d)}</td>
                  <td className="r dim">{duration(d.latest?.radio?.uptime)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!rows.length && (
          <div className="empty">
            <Icon name="search" size={14} /> Nothing matches.
          </div>
        )}
      </section>
      {sel && thresholds && <DevicePanel s={s} id={sel} close={() => setSel(null)} thresholds={thresholds} />}
    </div>
  );
}
