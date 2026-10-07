import { useEffect, useState } from 'react';
import type { AppState, DeviceState, Sample, Thresholds } from '../../core/types';
import { api } from '../api';
import { estInternet } from '../derive';
import { duration, n, roleLabel, sigClass } from '../format';
import { Icon } from './Icon';
import { LineChart, Pt } from './LineChart';
import { Pill } from './Pill';

const RANGES = [1, 6, 24, 48, 168];
type Tab = 'overview' | 'clients' | 'history' | 'raw';

/** Side panel on the Devices page for one radio. */
export function DevicePanel({ s, id, close, thresholds }: { s: AppState; id: string; close: () => void; thresholds: Thresholds }) {
  const d = s.devices.find((x) => x.cfg.id === id);
  const [tab, setTab] = useState<Tab>('overview');
  const [hours, setHours] = useState(24);
  const [hist, setHist] = useState<Sample[]>([]);
  const [raw, setRaw] = useState<unknown>(null);
  const [testMsg, setTestMsg] = useState('');

  useEffect(() => {
    setTestMsg('');
    setRaw(null);
  }, [id]);

  useEffect(() => {
    let alive = true;
    api
      .history(id, hours)
      .then((h) => alive && setHist(h))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [id, hours, s.lastPoll]);

  useEffect(() => {
    if (tab === 'raw') api.raw(id).then(setRaw).catch(() => undefined);
  }, [tab, id, s.lastPoll]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);

  if (!d) return null;
  const r = d.latest?.radio;
  const role = d.role;
  const series = (f: (x: Sample) => number | null | undefined): Pt[] => hist.map((h) => ({ t: h.t, v: f(h) ?? null }));
  const stations = [...(d.stationsLive ?? [])].sort((a, b) => (a.signal ?? -999) - (b.signal ?? -999));
  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ...(role === 'ap' || stations.length ? ([['clients', `Clients${stations.length ? ` (${stations.length})` : ''}`]] as [Tab, string][]) : []),
    ['history', 'History'],
    ['raw', 'Raw data'],
  ];

  const pingChart = (
    <LineChart
      title="Ping from this PC"
      unit="ms"
      hours={hours}
      data={series((x) => (x.pcFault ? null : x.ping.avg))}
      threshold={thresholds.latencyMs}
      min={0}
      extra={(i) => (hist[i] ? `worst ${n(hist[i].ping.max, ' ms')} · loss ${n(hist[i].ping.lossPct, '%')}` : null)}
    />
  );

  return (
    <aside className="card panel" aria-label={`${d.cfg.name} details`}>
      <div className="panel-h">
        <div className={`icon ${d.health === 'unknown' ? '' : d.health}`}>
          <Icon name={role === 'ap' ? 'ap' : 'radio'} size={22} stroke={1.6} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="t">{d.cfg.name}</div>
          <div className="s">
            {r?.model || roleLabel[role]} · {d.cfg.site} · <span className="mono">{d.cfg.ip}</span>
          </div>
          <div style={{ marginTop: 6 }}>
            <Pill h={d.health} />
          </div>
        </div>
        <button className="btn icon" aria-label="Close" onClick={close}>
          <Icon name="close" size={14} stroke={2.2} />
        </button>
      </div>

      <div className="ptabs" role="tablist">
        {tabs.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {d.latest?.error && (
        <div className="errbox">
          <b>Can't read this radio:</b> {d.latest.error}
        </div>
      )}

      {tab === 'overview' && (
        <>
          <div className="facts">
            {role === 'backbone-sta' && <Fact k="Signal" v={n(r?.signal, ' dBm')} />}
            <Fact k="Noise floor" v={n(r?.noise, ' dBm')} bad={role === 'ap' && r?.noise != null && r.noise > thresholds.apNoise} />
            {role !== 'ap' && <Fact k="CCQ" v={n(r?.ccq, '%', 1)} bad={r?.ccq != null && r.ccq < thresholds.backboneCcq} />}
            {role !== 'ap' && <Fact k="airMAX quality / capacity" v={`${n(r?.airmaxQuality, '%')} / ${n(r?.airmaxCapacity, '%')}`} />}
            {role === 'backbone-sta' && <Fact k="TX / RX rate" v={`${n(r?.txRate)} / ${n(r?.rxRate)} Mbps`} />}
            {role === 'ap' && <Fact k="Clients" v={d.latest?.stations ? `${d.latest.stations.count} (${d.latest.stations.weak} weak)` : '–'} />}
            <Fact k="Channel" v={r ? `${n(r.channel)} · ${n(r.frequency, ' MHz')}` : '–'} />
            <Fact k="TX power" v={n(r?.txPower, ' dBm')} />
            <Fact k="Ping (worst)" v={`${n(d.latest?.ping.avg)} (${n(d.latest?.ping.max)}) ms`} bad={(d.latest?.ping.avg ?? 0) > thresholds.latencyMs} />
            <Fact k="Packet loss" v={n(d.latest?.ping.lossPct, '%')} bad={(d.latest?.ping.lossPct ?? 0) > thresholds.lossPct} />
            <Fact k="Internet from here (estimate)" v={(() => { const e = estInternet(s, d); return e ? `${e.ms} ms · ${e.lossPct}% loss` : '–'; })()} />
            <Fact k="CPU / memory" v={`${n(r?.cpu, '%')} / ${n(r?.memPct, '%')}`} />
            <Fact k="Uptime" v={duration(r?.uptime)} />
          </div>
          <div className="psec">
            {pingChart}
            {role === 'backbone-sta' && (
              <LineChart title="airMAX capacity" unit="%" hours={hours} data={series((x) => x.radio?.airmaxCapacity)} threshold={thresholds.backboneCapacity} max={100} height={100} />
            )}
            {role === 'ap' && <LineChart title="Connected clients" unit="" hours={hours} data={series((x) => x.stations?.count)} min={0} height={100} />}
            {role === 'backbone-ap' && <LineChart title="CCQ" unit="%" hours={hours} data={series((x) => x.radio?.ccq)} threshold={thresholds.backboneCcq} max={100} digits={1} height={100} />}
          </div>
          <div className="facts" style={{ borderTop: '1px solid var(--border-soft)', borderBottom: 0 }}>
            <Fact k="Hostname" v={r?.hostname || '–'} />
            <Fact k="Firmware" v={r?.firmware || '–'} />
            <Fact k="Mode" v={r ? `${r.mode}${r.wds ? ' WDS' : ''}` : '–'} />
            <Fact k="SSID" v={r?.essid || '–'} />
            <Fact k="Channel width" v={n(r?.channelWidth, ' MHz')} />
            <Fact k="LAN" v={n(r?.lanSpeed, ' Mbps')} />
          </div>
        </>
      )}

      {tab === 'clients' && (
        <div className="tbl-wrap">
          {stations.length ? (
            <table>
              <thead>
                <tr>
                  <th>Signal</th>
                  <th>Device</th>
                  <th className="r">Down / up</th>
                  <th className="r">Connected</th>
                </tr>
              </thead>
              <tbody>
                {stations.map((st) => (
                  <tr key={st.mac}>
                    <td>
                      <SignalBar dbm={st.signal} weak={thresholds.weakSignal} />
                    </td>
                    <td>
                      <span className="mono">{st.mac}</span>
                      <div className={`hint ${!st.ip ? 'weak' : ''}`}>{st.ip || 'no IP address'}{st.name ? ` · ${st.name}` : ''}</div>
                    </td>
                    <td className={`r ${(st.rxRate ?? 99) <= 6.5 ? 'weak' : ''}`}>
                      {n(st.txRate, '', 1)} / {n(st.rxRate, '', 1)}
                    </td>
                    <td className="r dim">{duration(st.uptime)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">No clients connected right now.</div>
          )}
        </div>
      )}

      {tab === 'history' && (
        <div className="psec">
          <div className="row-actions">
            <div className="seg">
              {RANGES.map((h) => (
                <button key={h} className={h === hours ? 'on' : ''} onClick={() => setHours(h)}>
                  {h >= 48 ? `${h / 24}d` : `${h}h`}
                </button>
              ))}
            </div>
            <span className="hint">{hist.length} samples</span>
          </div>
          {pingChart}
          <LineChart title="Packet loss" unit="%" hours={hours} data={series((x) => (x.pcFault ? null : x.ping.lossPct))} min={0} max={100} height={100} />
          {role === 'backbone-sta' && (
            <>
              <LineChart title="Signal" unit="dBm" hours={hours} data={series((x) => x.radio?.signal)} height={110} />
              <LineChart title="airMAX capacity" unit="%" hours={hours} data={series((x) => x.radio?.airmaxCapacity)} threshold={thresholds.backboneCapacity} max={100} height={110} />
              <LineChart title="TX rate (back towards the house)" unit="Mbps" hours={hours} data={series((x) => x.radio?.txRate)} min={0} height={110} />
            </>
          )}
          {role !== 'ap' && <LineChart title="CCQ" unit="%" hours={hours} data={series((x) => x.radio?.ccq)} threshold={thresholds.backboneCcq} max={100} digits={1} height={110} />}
          <LineChart title="Noise floor" unit="dBm" hours={hours} data={series((x) => x.radio?.noise)} threshold={role === 'ap' ? thresholds.apNoise : undefined} height={110} />
          {role === 'ap' && (
            <>
              <LineChart title="Connected clients" unit="" hours={hours} data={series((x) => x.stations?.count)} min={0} height={110} />
              <LineChart title={`Clients weaker than ${thresholds.weakSignal} dBm`} unit="" hours={hours} data={series((x) => x.stations?.weak)} min={0} height={110} />
            </>
          )}
        </div>
      )}

      {tab === 'raw' && (
        <div className="psec">
          <span className="hint">The last reply from the radio's status page, for troubleshooting.</span>
          <pre className="raw">{raw ? JSON.stringify(raw, null, 2) : 'Loading…'}</pre>
        </div>
      )}

      <div className="pfoot">
        <a className="btn" href={`https://${d.cfg.ip}/`} target="_blank" rel="noreferrer">
          Open airOS <Icon name="external" size={13} stroke={2} />
        </a>
        <button
          className="btn"
          onClick={() => {
            setTestMsg('Testing…');
            api
              .test(d.cfg.ip)
              .then((x) => setTestMsg((x.ok ? 'OK: ' : 'Failed: ') + x.message))
              .catch((e) => setTestMsg('Failed: ' + String(e)));
          }}
        >
          Test login
        </button>
        {testMsg && <span className={`hint ${testMsg.startsWith('Failed') ? 'weak' : ''}`}>{testMsg}</span>}
      </div>
    </aside>
  );
}

function Fact({ k, v, bad }: { k: string; v: React.ReactNode; bad?: boolean }) {
  return (
    <div className="kv">
      <div className="k">{k}</div>
      <div className={`v ${bad ? 'weak' : ''}`}>{v}</div>
    </div>
  );
}

export function SignalBar({ dbm, weak }: { dbm: number | null; weak: number }) {
  const c = sigClass(dbm, weak);
  const pct = dbm === null ? 0 : Math.max(0, Math.min(100, ((dbm + 95) / 50) * 100));
  return (
    <span className="sig">
      <span className="bar">
        <span style={{ width: `${pct}%`, background: `var(--${c === 'unknown' ? 'text-3' : c})` }} />
      </span>
      <span className={c === 'critical' ? 'weak' : ''}>{n(dbm, ' dBm')}</span>
    </span>
  );
}

/** One-line link summary for the device table. */
export function linkSummary(d: DeviceState) {
  const r = d.latest?.radio;
  if (!r) return d.latest?.error ? 'no login' : '–';
  if (d.role === 'backbone-sta') return `${n(r.signal, ' dBm')} · ${n(r.airmaxCapacity, '%')}`;
  if (d.role === 'backbone-ap') return `${n(r.frequency, ' MHz')} · ${n(r.ccq, '%')} CCQ`;
  const c = d.latest?.stations?.count;
  return `ch ${n(r.channel)} · ${c ?? '–'} client${c === 1 ? '' : 's'}`;
}
