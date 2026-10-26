import type { AppState, TopClient } from '../../core/types';
import { ago, clock } from '../format';

const label = (c: TopClient) => c.name || c.vendor || c.mac;
const what = (c: TopClient) => (c.apps?.length ? c.apps.map((a) => `${a.cat} (${a.mb} MB)`).join(', ') : '–');
const day = (t: number, now: number) => (new Date(t).toDateString() === new Date(now).toDateString() ? 'Today' : new Date(t).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }));

/** Who is using the internet right now, and every spike with the devices that caused it. */
export function UsageCard({ s }: { s: AppState }) {
  const g = s.gateways.find((x) => x.cfg.enabled);
  if (!g?.latest?.gw) return null;
  const gw = g.latest.gw;
  const now = gw.top ?? [];
  const dpiOff = gw.dpiOk === false;
  return (
    <section className="card">
      <div className="card-h">
        <h2>Who is using the internet</h2>
        <span className="sub">
          Devices on {gw.usageNetwork ?? 'the customers\' network'} (house devices are left out): every device's speed every 15 s. Spikes over {s.spikeMbps} Mbps are logged with the devices behind them (change the level in
          Settings). The kind of traffic comes from UniFi's traffic identification; websites are not recorded.
        </span>
      </div>
      {gw.usageNetwork === null && (
        <div className="card-b hint">
          No customers' network found on {g.cfg.name}, so nothing is being counted. Pick it in Settings, under {g.cfg.name}.
        </div>
      )}
      {dpiOff && (
        <div className="card-b hint">
          UniFi isn't reporting the kind of traffic. Turn on <b>Traffic Identification</b> on {g.cfg.name} (in UniFi, Settings, then Security / CyberSecure, depending on
          version) to see whether a spike was streaming, an update, a download and so on.
        </div>
      )}
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Busiest in the last minute</th>
              <th>Network</th>
              <th>IP</th>
              <th className="r">Down / up Mbps</th>
              <th className="r">Peak</th>
              <th>Kind of traffic</th>
            </tr>
          </thead>
          <tbody>
            {now.length ? (
              now.map((c) => (
                <tr key={c.mac}>
                  <td>
                    <b>{label(c)}</b> <span className="faint mono">{c.mac}</span>
                  </td>
                  <td>{c.network || '–'}</td>
                  <td className="mono dim">{c.ip || '–'}</td>
                  <td className="r">
                    {c.downMbps} / {c.upMbps}
                  </td>
                  <td className="r dim">{c.peakMbps}</td>
                  <td className="dim" style={{ whiteSpace: 'normal' }}>
                    {what(c)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={6} className="empty">
                  Nothing much in the last minute.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="card-h" style={{ borderTop: '1px solid var(--border-soft)' }}>
        <h2 style={{ fontSize: 14 }}>Spikes and who caused them</h2>
        <span className="sub">Busiest 15 s of each minute that went over {s.spikeMbps} Mbps, newest first</span>
      </div>
      {s.busy.length ? (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th className="r">To the caravans</th>
                <th>Mostly</th>
                <th>Kind of traffic</th>
                <th>Also</th>
              </tr>
            </thead>
            <tbody>
              {s.busy.slice(0, 20).map((b) => {
                const [first, ...rest] = b.clients;
                return (
                  <tr key={b.t + b.gatewayId}>
                    <td>
                      {day(b.t, s.now)} {clock(b.t)} <div className="faint">{ago(b.t, s.now)}</div>
                    </td>
                    <td className="r">
                      <b>{b.totalDown} Mbps</b>
                    </td>
                    <td>
                      <b>{label(first)}</b>
                      <div className="faint">
                        {first.network} · {first.ip} · {first.downMbps} Mbps{first.share != null ? ` (${first.share}%)` : ''}
                      </div>
                    </td>
                    <td className="dim" style={{ whiteSpace: 'normal' }}>
                      {what(first)}
                    </td>
                    <td className="dim" style={{ whiteSpace: 'normal' }}>
                      {rest.map((c) => `${label(c)} ${c.downMbps} Mbps`).join(', ') || '–'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">No spikes over {s.spikeMbps} Mbps logged yet.</div>
      )}
    </section>
  );
}
