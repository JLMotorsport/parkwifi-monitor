import type { AppState, DeviceState } from '../../core/types';
import { accessPoints, chainDevices, goodShare, probeHealth, shareHealth } from '../derive';
import { duration, n } from '../format';
import { AlertList } from './Alerts';
import { Icon } from './Icon';
import { HEALTH_LABEL, StatusIcon, worst, type Health } from './Pill';

type Page = 'devices' | 'clients' | 'alerts';

interface Props {
  s: AppState;
  open: (id: string) => void;
  goto: (p: Page) => void;
  latencyLimit: number;
}

export function Overview({ s, open, goto, latencyLimit }: Props) {
  const chain = chainDevices(s);
  const aps = accessPoints(s);
  const internet = s.probes.find((p) => p.probe.id === 'internet') ?? s.probes[0];
  const end = chain[chain.length - 1];

  const backboneH = worst(chain.map((d) => d.health));
  const weak = aps.reduce((a, d) => a + (d.latest?.stations?.weak ?? 0), 0);
  const clients = aps.reduce((a, d) => a + (d.latest?.stations?.count ?? 0), 0);
  const enabled = s.devices.filter((d) => d.cfg.enabled);
  const online = enabled.filter((d) => (d.latest?.ping.received ?? 0) > 0).length;
  const dayAgo = s.now - 86400000;
  const restarts = s.events.filter((e) => e.event && e.key.split(':')[1] === 'reboot' && e.startedAt >= dayAgo).length;
  const netH = probeHealth(internet?.latest?.ping);

  const apRows = [...aps].sort((a, b) => (b.latest?.stations?.weak ?? 0) - (a.latest?.stations?.weak ?? 0));

  return (
    <>
      <div className="tiles">
        <Tile
          label="Backbone latency"
          h={backboneH}
          big={n(end?.latest?.ping.avg, '', 0)}
          small={`ms to ${end?.cfg.site || 'end'}`}
          foot={`worst ${n(end?.latest?.ping.max, ' ms')} · loss ${n(end?.latest?.ping.lossPct, '%')}`}
        />
        <Tile
          label="Internet"
          h={netH}
          status={netH === 'good' ? 'Online' : netH === 'critical' ? 'Offline' : undefined}
          big={n(internet?.latest?.ping.avg, '', 0)}
          small="ms"
          foot={`${internet?.probe.host ?? ''} from this PC · loss ${n(internet?.latest?.ping.lossPct, '%')}`}
        />
        <Tile
          label="Clients"
          h={!clients ? 'unknown' : weak > clients / 3 ? 'warning' : 'good'}
          status={weak ? `${weak} weak` : clients ? 'All strong' : undefined}
          big={String(clients)}
          small={`on ${aps.length} APs`}
          onClick={() => goto('clients')}
          extra={
            <div className="split" role="img" aria-label={`${clients - weak} on a good signal, ${weak} weak`}>
              <span style={{ width: `${clients ? ((clients - weak) / clients) * 100 : 0}%`, background: 'var(--accent)' }} />
              <span style={{ width: `${clients ? (weak / clients) * 100 : 0}%`, background: 'var(--warning)' }} />
            </div>
          }
        />
        <Tile
          label="Radios"
          h={!enabled.length ? 'unknown' : online === enabled.length ? 'good' : online === 0 ? 'critical' : 'serious'}
          status={`${online} online`}
          big={String(online)}
          small={`/ ${enabled.length}`}
          foot={restarts ? `${restarts} restart${restarts === 1 ? '' : 's'} in the last 24 h` : 'No restarts in the last 24 h'}
          onClick={() => goto('devices')}
        />
      </div>

      <section className="card">
        <div className="card-h">
          <h2>Backbone</h2>
          <span className="sub">Ping from this PC; the figure over each link is the delay that hop adds.</span>
        </div>
        <Topology s={s} chain={chain} open={open} latencyLimit={latencyLimit} />
      </section>

      <div className="row2">
        <section className="card" style={{ flex: '2 1 560px' }}>
          <div className="card-h">
            <h2>Access points</h2>
            <span className="sub">sorted by weak clients</span>
            <span className="spacer" />
            <button className="linkbtn" onClick={() => goto('devices')}>
              View all devices
            </button>
          </div>
          <div className="tbl-wrap">
            <table style={{ minWidth: 620 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Channel</th>
                  <th>Noise</th>
                  <th>Clients</th>
                  <th style={{ width: 200 }}>Good signal</th>
                  <th className="r">Uptime</th>
                </tr>
              </thead>
              <tbody>
                {apRows.map((d) => {
                  const r = d.latest?.radio;
                  const st = d.latest?.stations;
                  const g = goodShare(d);
                  const gh = shareHealth(g);
                  const noisy = r?.noise != null && r.noise > -80;
                  return (
                    <tr key={d.cfg.id} className="click" onClick={() => open(d.cfg.id)}>
                      <td>
                        <span className="namecell">
                          <span className={`sdot ${d.health}`} title={HEALTH_LABEL[d.health]} />
                          <b>{d.cfg.name}</b>
                        </span>
                      </td>
                      <td className="dim">{r?.channel ?? '–'}</td>
                      <td className={`mono ${noisy ? 'weak' : 'dim'}`}>{n(r?.noise, ' dBm')}</td>
                      <td>
                        {st?.count ?? '–'} {!!st?.weak && <span className="warnv">({st.weak} weak)</span>}
                      </td>
                      <td>
                        <span className="meter">
                          <span className="trk">
                            <span style={{ width: `${g ?? 0}%`, background: gh === 'good' ? 'var(--accent)' : `var(--${gh === 'unknown' ? 'track' : gh})` }} />
                          </span>
                          <span className="v">{g === null ? '–' : `${g}%`}</span>
                        </span>
                      </td>
                      <td className="r dim">{duration(r?.uptime)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {!aps.length && <div className="empty">No access points found yet. Use Discover radios in Settings.</div>}
          </div>
        </section>

        <section className="card" style={{ flex: '1 1 340px' }}>
          <div className="card-h">
            <h2>Alerts</h2>
            <span className="spacer" />
            <button className="linkbtn" onClick={() => goto('alerts')}>
              History
            </button>
          </div>
          <AlertList items={s.alerts.length ? s.alerts : s.events} limit={6} now={s.now} open={open} empty="Nothing to report." />
        </section>
      </div>
    </>
  );
}

function Tile(p: { label: string; h: Health; status?: string; big: string; small: string; foot?: string; extra?: React.ReactNode; onClick?: () => void }) {
  const body = (
    <>
      <div className="label">
        {p.label}
        <span className={`st ink-${p.h}`}>
          <StatusIcon h={p.h} size={11} />
          {p.status ?? HEALTH_LABEL[p.h]}
        </span>
      </div>
      <div className="big">
        {p.big}
        <small>{p.small}</small>
      </div>
      {p.foot && <div className="foot">{p.foot}</div>}
      {p.extra}
    </>
  );
  return p.onClick ? (
    <button className="card tile" onClick={p.onClick}>
      {body}
    </button>
  ) : (
    <div className="card tile">{body}</div>
  );
}

/** Consecutive chain radios at the same site share one node (station + sender on one mast). */
function groupBySite(chain: DeviceState[]) {
  const groups: DeviceState[][] = [];
  for (const d of chain) {
    const g = groups[groups.length - 1];
    if (g && g[0].cfg.site && g[0].cfg.site === d.cfg.site) g.push(d);
    else groups.push([d]);
  }
  return groups;
}

function Topology({ s, chain, open, latencyLimit }: { s: AppState; chain: DeviceState[]; open: (id: string) => void; latencyLimit: number }) {
  const groups = groupBySite(chain);
  const routers = s.probes.filter((p) => p.probe.id !== 'internet');
  if (!chain.length) return <div className="empty">No backbone radios in the chain. Set the order in Settings.</div>;
  return (
    <div className="topo-scroll">
      <div className="topo">
        {routers.map((p) => {
          const h = probeHealth(p.latest?.ping);
          return [
            <div className="tnode" key={p.probe.id}>
              <div className="box router">
                <Icon name="router" size={30} stroke={1.7} />
                {h !== 'good' && (
                  <span className={`badge ${h}`}>
                    <StatusIcon h={h} size={10} />
                  </span>
                )}
              </div>
              <div className="nm">{p.probe.name}</div>
              <div className="ips">
                <span className="ip">{p.probe.host}</span>
              </div>
              <div className={`lat ink-${h === 'good' ? 'unknown' : h}`}>{n(p.latest?.ping.avg, ' ms')}</div>
            </div>,
            <div className="tlink" key={p.probe.id + '-l'}>
              <span className="add" />
              <div className="line" />
              <span className="meta">cable</span>
            </div>,
          ];
        })}
        {groups.map((g, gi) => {
          const h = worst(g.map((d) => d.health));
          const last = g[g.length - 1];
          const next = groups[gi + 1];
          return [
            <div className="tnode" key={g[0].cfg.id}>
              <div className={`box ${h}`} role="button" tabIndex={0} title={`Open ${last.cfg.name}`} onClick={() => open(last.cfg.id)} onKeyDown={(e) => e.key === 'Enter' && open(last.cfg.id)}>
                <Icon name="radio" size={28} stroke={1.6} />
                <span className={`badge ${h}`} aria-label={HEALTH_LABEL[h]}>
                  <StatusIcon h={h} size={10} />
                </span>
              </div>
              <div className="nm">{g[0].cfg.site || g[0].cfg.name}</div>
              <div className="ips">
                {g.map((d) => (
                  <button key={d.cfg.id} className="ip" title={d.cfg.name} onClick={() => open(d.cfg.id)}>
                    .{d.cfg.ip.split('.').slice(-2).join('.')}
                  </button>
                ))}
              </div>
              <div className={`lat ${(last.latest?.ping.avg ?? 0) > latencyLimit ? 'ink-critical' : ''}`}>{n(last.latest?.ping.avg, ' ms')}</div>
            </div>,
            next && <Hop key={g[0].cfg.id + '-l'} from={last} to={next[0]} />,
          ];
        })}
      </div>
    </div>
  );
}

function Hop({ from, to }: { from: DeviceState; to: DeviceState }) {
  const added = from.latest?.ping.avg != null && to.latest?.ping.avg != null ? to.latest.ping.avg - from.latest.ping.avg : null;
  // the receiving station reports the link's signal and airMAX figures; the sender its channel
  const r = to.latest?.radio;
  const a = from.role === 'backbone-ap' ? from.latest?.radio : undefined;
  const cap = r?.airmaxCapacity ?? null;
  const cls = added === null ? '' : added >= 20 ? 'bad' : added >= 8 ? 'mid' : 'ok';
  return (
    <div className={`tlink air ${cls === 'bad' ? 'bad' : ''}`}>
      <span className={`add ${cls}`}>{added === null ? '–' : added < 2 ? '~0 ms' : `+${added.toFixed(0)} ms`}</span>
      <div className="line" />
      <span className="meta">
        {n(r?.frequency ?? a?.frequency, ' MHz')} · {n(r?.signal, ' dBm')} · <span className={cap !== null && cap < 80 ? 'w' : ''}>{n(cap, '%')}</span>
      </span>
    </div>
  );
}
