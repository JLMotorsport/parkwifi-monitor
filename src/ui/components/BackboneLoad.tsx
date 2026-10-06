import { useEffect, useState } from 'react';
import type { AppState, Sample } from '../../core/types';
import { api } from '../api';
import { ago, duration } from '../format';
import { LineChart } from './LineChart';

/** Traffic on the UDR3 port that feeds the radios, plus UDR3's own internet latency and DHCP use. */
export function BackboneLoad({ s, goSettings }: { s: AppState; goSettings: () => void }) {
  const g = s.gateways.find((x) => x.cfg.enabled) ?? s.gateways[0];
  const [hist, setHist] = useState<Sample[]>([]);
  const [hours, setHours] = useState(24);
  const id = g ? 'gw:' + g.cfg.id : '';

  useEffect(() => {
    if (!g?.cfg.enabled) return;
    let alive = true;
    api
      .history(id, Math.max(hours, 24))
      .then((h) => alive && setHist(h.filter((x) => x.gw)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, hours, s.lastPoll, g?.cfg.enabled]);

  if (!g) return null;
  if (!g.cfg.enabled || !g.cfg.hasPassword || !g.cfg.username) {
    return (
      <section className="card">
        <div className="card-h">
          <h2>Backbone load</h2>
          <span className="sub">Needs a login to {g.cfg.name}</span>
          <span className="spacer" />
          <button className="btn small" onClick={goSettings}>
            Connect in Settings
          </button>
        </div>
        <div className="card-b hint">
          Reading UDR3 shows how busy the link to Lookout and Monks gets at peak times, UDR3's own internet latency, and how full the DHCP address pool is.
        </div>
      </section>
    );
  }

  const gw = g.latest?.gw;
  const cap = s.backboneMbps;
  const since = s.now - hours * 3600000;
  const shown = hist.filter((x) => x.t >= since);
  const midnight = new Date(s.now).setHours(0, 0, 0, 0);
  const today = hist.filter((x) => x.t >= midnight && x.gw?.watch);
  const busiest = today.reduce<Sample | null>((b, x) => (!b || x.gw!.watch!.downPeak > b.gw!.watch!.downPeak ? x : b), null);
  const p95 = g.load?.peakDown95 ?? null;
  const loadMinutes = g.load?.samples ?? 0;
  const pct = p95 !== null && cap ? Math.round((p95 / cap) * 100) : null;
  const pctH = pct === null ? 'unknown' : pct >= 95 ? 'critical' : pct >= 80 ? 'warning' : 'good';
  const w = gw?.watch;
  const series = (f: (x: Sample) => number | null | undefined) => shown.map((x) => ({ t: x.t, v: f(x) ?? null }));
  const clock = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  return (
    <section className="card">
      <div className="card-h">
        <h2>Backbone load</h2>
        <span className="sub">
          {w ? `UDR3 port "${w.name}", read every 15 s` : 'UDR3'}
          {gw?.uptime != null && ` · UDR3 up ${duration(gw.uptime)}`}
        </span>
        <span className="spacer" />
        <div className="seg">
          {[6, 24, 72].map((h) => (
            <button key={h} className={h === hours ? 'on' : ''} onClick={() => setHours(h)}>
              {h === 72 ? '3d' : `${h}h`}
            </button>
          ))}
        </div>
      </div>
      {g.error && (
        <div className="errbox" style={{ marginTop: 0, marginBottom: 12 }}>
          <b>Can't read {g.cfg.name}:</b> {g.error} {g.errorAt ? `(${ago(g.errorAt, s.now)})` : ''}
        </div>
      )}
      {!w && !g.error && gw && <div className="card-b hint">Connected, but no port is named after Lookout or Monks. Pick the port that feeds the radios in Settings.</div>}
      <div className="facts wide" style={{ borderTop: '1px solid var(--border-soft)' }}>
        <div className="kv">
          <div className="k">Now, to the caravans / from them</div>
          <div className="v">{w ? `${w.downMbps} / ${w.upMbps} Mbps` : '–'}</div>
        </div>
        <div className="kv">
          <div className="k">Busiest moment today</div>
          <div className="v">{busiest ? <>{busiest.gw!.watch!.downPeak} Mbps <small>at {clock(busiest.t)}</small></> : '–'}</div>
        </div>
        <div className="kv">
          <div className="k">Busy-time peak, last 3 days</div>
          <div className={`v ink-${pctH === 'good' ? '' : pctH}`}>
            {p95 !== null ? (
              <>
                {p95} Mbps <small>{pct}% of {cap}</small>
              </>
            ) : (
              '–'
            )}
          </div>
        </div>
        <div className="kv">
          <div className="k">Internet latency, measured by UDR3</div>
          <div className="v">{gw?.wanLatency != null ? `${gw.wanLatency} ms` : '–'}</div>
        </div>
      </div>
      {pct !== null && (
        <div className="card-b" style={{ paddingTop: 12 }}>
          <div className="meter" style={{ maxWidth: 560 }}>
            <span className="trk" role="img" aria-label={`Busy-time peak is ${pct}% of the backbone's capacity`}>
              <span style={{ width: `${Math.min(100, pct)}%`, background: pctH === 'good' ? 'var(--accent)' : `var(--${pctH})` }} />
            </span>
            <span className="v" style={{ width: 'auto' }}>
              {loadMinutes < 360 ? `${Math.round(loadMinutes / 60)} h of data so far; give it a few evenings` : pct >= 80 ? 'near full at busy times' : 'room to spare'}
            </span>
          </div>
        </div>
      )}
      <div className="card-b charts">
        <LineChart title="To the caravans (busiest 15 s each minute)" unit="Mbps" hours={hours} data={series((x) => x.gw?.watch?.downPeak)} threshold={cap} min={0} height={130} />
        <LineChart title="From the caravans (uploads)" unit="Mbps" hours={hours} data={series((x) => x.gw?.watch?.upPeak)} min={0} height={130} />
      </div>
      {gw && gw.networks.length > 0 && (
        <div className="tbl-wrap" style={{ borderTop: '1px solid var(--border-soft)' }}>
          <table>
            <thead>
              <tr>
                <th>Network on UDR3</th>
                <th>Subnet</th>
                <th className="r">Active devices</th>
                <th className="r">DHCP range</th>
                <th style={{ width: 200 }}>Range used</th>
                <th className="r">Lease</th>
              </tr>
            </thead>
            <tbody>
              {gw.networks.map((n) => {
                const used = n.poolSize ? Math.round((n.clients / n.poolSize) * 100) : null;
                const h = used === null ? 'unknown' : used >= 100 ? 'critical' : used >= 85 ? 'warning' : 'good';
                return (
                  <tr key={n.name}>
                    <td>
                      <b>{n.name}</b>
                    </td>
                    <td className="mono dim">{n.subnet || '–'}</td>
                    <td className="r">{n.clients}</td>
                    <td className="r dim">{n.poolSize ?? 'DHCP off'}</td>
                    <td>
                      <span className="meter">
                        <span className="trk">
                          <span style={{ width: `${Math.min(100, used ?? 0)}%`, background: h === 'good' ? 'var(--accent)' : `var(--${h === 'unknown' ? 'track' : h})` }} />
                        </span>
                        <span className={`v ${h === 'critical' || h === 'warning' ? 'warnv' : ''}`}>{used === null ? '–' : `${used}%`}</span>
                      </span>
                    </td>
                    <td className="r dim">{n.leaseSeconds ? `${Math.round(n.leaseSeconds / 3600)} h` : '–'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
