import type { AppState, DeviceState } from '../../core/types';
import { ago, duration, n, sigClass } from '../format';
import { AlertList } from './Alerts';
import { Pill } from './Pill';

interface Props {
  s: AppState;
  open: (id: string) => void;
  goto: (tab: 'aps' | 'alerts') => void;
}

export function Overview({ s, open, goto }: Props) {
  const byId = new Map(s.devices.map((d) => [d.cfg.id, d]));
  const chain = s.chain.map((id) => byId.get(id)).filter((d): d is DeviceState => !!d && d.cfg.enabled);
  const aps = s.devices.filter((d) => d.cfg.enabled && (d.role === 'ap' || (d.role === 'unknown' && !s.chain.includes(d.cfg.id))));
  const internet = s.probes.find((p) => p.probe.id === 'internet') ?? s.probes[0];
  const end = chain[chain.length - 1];

  const backboneWorst = worst(chain.map((d) => d.health));
  const apIssues = aps.filter((a) => a.health !== 'good' && a.health !== 'unknown').length;
  const weakTotal = aps.reduce((a, d) => a + (d.latest?.stations?.weak ?? 0), 0);
  const clientTotal = aps.reduce((a, d) => a + (d.latest?.stations?.count ?? 0), 0);

  return (
    <>
      <div className="tiles">
        <div className="card tile">
          <div className="label">
            Backbone <Pill h={backboneWorst} />
          </div>
          <div className="big">
            {n(end?.latest?.ping.avg, '', 0)}
            <small>ms to {end?.cfg.site ?? 'end'}</small>
          </div>
          <div className="foot">
            worst {n(end?.latest?.ping.max, ' ms')} · loss {n(end?.latest?.ping.lossPct, '%')}
          </div>
        </div>
        <div className="card tile">
          <div className="label">
            Internet <Pill h={probeHealth(internet?.latest?.ping)} />
          </div>
          <div className="big">
            {n(internet?.latest?.ping.avg, '', 0)}
            <small>ms</small>
          </div>
          <div className="foot">from this PC · loss {n(internet?.latest?.ping.lossPct, '%')}</div>
        </div>
        <div className="card tile" style={{ cursor: 'pointer' }} onClick={() => goto('aps')}>
          <div className="label">
            Customer devices <Pill h={weakTotal > clientTotal / 3 ? 'warning' : clientTotal ? 'good' : 'unknown'} label={`${aps.length} APs`} />
          </div>
          <div className="big">
            {clientTotal}
            <small>connected</small>
          </div>
          <div className="foot">
            {weakTotal} on a weak signal · {apIssues} AP{apIssues === 1 ? '' : 's'} with issues
          </div>
        </div>
        <div className="card tile" style={{ cursor: 'pointer' }} onClick={() => goto('alerts')}>
          <div className="label">
            Active alerts <Pill h={worst(s.alerts.map((a) => a.severity))} label={s.alerts.length ? `${s.alerts.length}` : 'None'} />
          </div>
          <div className="big">{s.alerts.length}</div>
          <div className="foot">last poll {ago(s.lastPoll, s.now)}</div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Backbone</h2>
          <span className="sub">House to Monks Meadow. Ping is from this PC, so each hop adds to the one before.</span>
        </div>
        <div className="card-b spine">
          {s.probes
            .filter((p) => p.probe.id !== 'internet')
            .map((p) => (
              <div key={p.probe.id}>
                <div className="node" style={{ cursor: 'default' }}>
                  <span className={`dot ${probeHealth(p.latest?.ping)}`} />
                  <div className="nm">
                    {p.probe.name}
                    <small className="mono">{p.probe.host}</small>
                  </div>
                  <KV k="Ping" v={n(p.latest?.ping.avg, ' ms')} />
                  <KV k="Worst" v={n(p.latest?.ping.max, ' ms')} />
                  <KV k="Loss" v={n(p.latest?.ping.lossPct, '%')} cls="hide-sm" />
                  <span className="hide-sm" />
                </div>
                <Link wireless={false} text="cable" />
              </div>
            ))}
          {chain.map((d, i) => {
            const next = chain[i + 1];
            const wireless = next ? isWireless(d, next, i) : false;
            const prevAvg = i > 0 ? chain[i - 1].latest?.ping.avg : null;
            return (
              <div key={d.cfg.id}>
                <Node d={d} open={open} added={d.latest?.ping.avg != null && prevAvg != null ? d.latest.ping.avg - prevAvg : null} />
                {next && (wireless ? <WirelessLink from={d} to={next} /> : <Link wireless={false} text={`cable at ${d.cfg.site}`} />)}
              </div>
            );
          })}
          {!chain.length && <div className="empty">No backbone radios in the chain. Set the order in Settings.</div>}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Active alerts</h2>
        </div>
        <div className="card-b">
          <AlertList items={s.alerts} now={s.now} open={open} empty="Nothing wrong right now." />
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Access points</h2>
          <span className="sub">Devices weaker than -75 dBm usually can't upload.</span>
        </div>
        <div className="card-b apgrid">
          {aps.map((a) => (
            <ApCard key={a.cfg.id} d={a} open={open} />
          ))}
          {!aps.length && <div className="empty">No access points found yet.</div>}
        </div>
      </div>
    </>
  );
}

function KV({ k, v, cls }: { k: string; v: React.ReactNode; cls?: string }) {
  return (
    <div className={`kv ${cls ?? ''}`}>
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}

function Node({ d, open, added }: { d: DeviceState; open: (id: string) => void; added: number | null }) {
  const p = d.latest?.ping;
  const r = d.latest?.radio;
  return (
    <div className="node" onClick={() => open(d.cfg.id)} title="Open details">
      <span className={`dot ${d.health}`} />
      <div className="nm">
        {d.cfg.name}
        <small>
          {d.cfg.site} · <span className="mono">{d.cfg.ip}</span>
        </small>
      </div>
      <KV k="Ping (worst)" v={`${n(p?.avg, '')} (${n(p?.max, '')}) ms`} />
      <KV k="Added by hop" v={added === null ? '–' : `${added > 0 ? '+' : ''}${added.toFixed(0)} ms`} />
      <KV k="Loss" v={n(p?.lossPct, '%')} cls="hide-sm" />
      <KV k="Up" v={r ? duration(r.uptime) : d.latest?.error ? <span className="weak">no login</span> : '–'} cls="hide-sm" />
    </div>
  );
}

function Link({ wireless, text }: { wireless: boolean; text: string }) {
  return (
    <div className={`link ${wireless ? 'wireless' : ''}`}>
      <div className="rail">
        <i />
      </div>
      <div className="info">{text}</div>
    </div>
  );
}

function WirelessLink({ from, to }: { from: DeviceState; to: DeviceState }) {
  // the receiving station reports the link's signal, rates and airMAX figures
  const r = to.latest?.radio;
  const a = from.latest?.radio;
  const cap = r?.airmaxCapacity ?? null;
  const ccq = r?.ccq ?? a?.ccq ?? null;
  const rate = r ? `${n(r.txRate)}/${n(r.rxRate)}` : '–';
  const rateLow = r && ((r.txRate ?? 999) < 100 || (r.rxRate ?? 999) < 100);
  return (
    <div className="link wireless">
      <div className="rail">
        <i />
      </div>
      <div className="info">
        <span>
          radio <b>{n(r?.frequency ?? a?.frequency, ' MHz')}</b>
        </span>
        <span>
          signal <b className={sigClass(r?.signal, -70) === 'critical' ? 'bad' : ''}>{n(r?.signal, ' dBm')}</b>
        </span>
        <span>
          noise <b>{n(r?.noise, ' dBm')}</b> (sender {n(a?.noise, ' dBm')})
        </span>
        <span>
          CCQ <b className={ccq !== null && ccq < 90 ? 'warn' : ''}>{n(ccq, '%', 1)}</b>
        </span>
        <span>
          capacity <b className={cap !== null && cap < 80 ? 'warn' : ''}>{n(cap, '%')}</b>
        </span>
        <span>
          rate <b className={rateLow ? 'warn' : ''}>{rate} Mbps</b>
        </span>
      </div>
    </div>
  );
}

export function ApCard({ d, open }: { d: DeviceState; open: (id: string) => void }) {
  const st = d.latest?.stations;
  const r = d.latest?.radio;
  return (
    <div className="card ap" onClick={() => open(d.cfg.id)}>
      <div className="row">
        <b>{d.cfg.name}</b>
        <Pill h={d.health} />
      </div>
      <div className="faint" style={{ fontSize: 12 }}>
        {d.cfg.site} · ch {n(r?.channel)} · {n(r?.txPower, ' dBm')}
      </div>
      <div className="meta">
        <div className="kv">
          <div className="k">Devices</div>
          <div className="v">{st?.count ?? '–'}</div>
        </div>
        <div className="kv">
          <div className="k">Weak</div>
          <div className={`v ${st?.weak ? 'weak' : ''}`}>{st?.weak ?? '–'}</div>
        </div>
        <div className="kv">
          <div className="k">Noise</div>
          <div className="v">{n(r?.noise)}</div>
        </div>
      </div>
    </div>
  );
}

function isWireless(a: DeviceState, b: DeviceState, i: number) {
  if (a.role === 'backbone-ap' && b.role === 'backbone-sta') return true;
  if (a.role === 'backbone-sta' && b.role === 'backbone-ap') return false;
  if (a.cfg.site !== b.cfg.site) return true;
  return i % 2 === 0;
}

type H = 'good' | 'warning' | 'serious' | 'critical' | 'unknown';
export function worst(hs: H[]): H {
  const rank: Record<H, number> = { unknown: -1, good: 0, warning: 1, serious: 2, critical: 3 };
  let w: H = hs.length ? 'good' : 'unknown';
  for (const h of hs) if (rank[h] > rank[w]) w = h;
  return w;
}

function probeHealth(p?: { received: number; lossPct: number; avg: number | null }): H {
  if (!p) return 'unknown';
  if (p.received === 0) return 'critical';
  if (p.lossPct > 5) return 'serious';
  if ((p.avg ?? 0) > 60) return 'warning';
  return 'good';
}
