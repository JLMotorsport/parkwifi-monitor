import { useEffect, useState } from 'react';
import type { AppState, Sample } from '../../core/types';
import { api } from '../api';
import { duration, n, roleLabel, sigClass } from '../format';
import { LineChart, Pt } from './LineChart';
import { Pill } from './Pill';

const RANGES = [1, 6, 24, 48, 168];

export function DeviceDetail({ s, id, close, thresholds }: { s: AppState; id: string; close: () => void; thresholds: { latencyMs: number; backboneCcq: number; backboneCapacity: number; apNoise: number; weakSignal: number } }) {
  const d = s.devices.find((x) => x.cfg.id === id);
  const [hours, setHours] = useState(24);
  const [hist, setHist] = useState<Sample[]>([]);
  const [raw, setRaw] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    const load = () => api.history(id, hours).then((h) => alive && setHist(h)).catch(() => undefined);
    load();
    const t = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, hours, s.lastPoll]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [close]);

  if (!d) return null;
  const r = d.latest?.radio;
  const series = (f: (x: Sample) => number | null | undefined): Pt[] => hist.map((h) => ({ t: h.t, v: f(h) ?? null }));
  const role = d.role;
  const stations = [...(d.stationsLive ?? [])].sort((a, b) => (a.signal ?? -999) - (b.signal ?? -999));

  return (
    <>
      <div className="scrim" onClick={close} />
      <aside className="drawer" role="dialog" aria-label={d.cfg.name}>
        <div className="drawer-h">
          <h1>{d.cfg.name}</h1>
          <Pill h={d.health} />
          <span className="muted">
            {roleLabel[role]} · {d.cfg.site} · <span className="mono">{d.cfg.ip}</span>
          </span>
          <span style={{ flex: 1 }} />
          <a className="btn small" href={`https://${d.cfg.ip}/`} target="_blank" rel="noreferrer">
            Open airOS ↗
          </a>
          <button className="btn small" onClick={close}>
            Close
          </button>
        </div>

        {d.latest?.error && (
          <div className="banner">
            <b>Can't read this radio:</b> {d.latest.error}
          </div>
        )}

        <div className="card">
          <div className="card-b facts" style={{ paddingTop: 16 }}>
            <Fact k="Model" v={r?.model || '–'} />
            <Fact k="Hostname" v={r?.hostname || '–'} />
            <Fact k="Firmware" v={r?.firmware || '–'} />
            <Fact k="Uptime" v={duration(r?.uptime)} />
            <Fact k="Mode" v={r ? `${r.mode}${r.wds ? ' WDS' : ''}` : '–'} />
            <Fact k="SSID" v={r?.essid || '–'} />
            <Fact k="Frequency" v={r ? `${n(r.frequency, ' MHz')} (ch ${n(r.channel)}, ${n(r.channelWidth, ' MHz')})` : '–'} />
            <Fact k="TX power" v={n(r?.txPower, ' dBm')} />
            {role === 'backbone-sta' && <Fact k="Signal" v={n(r?.signal, ' dBm')} />}
            <Fact k="Noise floor" v={n(r?.noise, ' dBm')} />
            <Fact k="CCQ" v={n(r?.ccq, '%', 1)} />
            {role !== 'ap' && <Fact k="airMAX quality / capacity" v={`${n(r?.airmaxQuality, '%')} / ${n(r?.airmaxCapacity, '%')}`} />}
            {role === 'backbone-sta' && <Fact k="TX / RX rate" v={`${n(r?.txRate)} / ${n(r?.rxRate)} Mbps`} />}
            <Fact k="CPU / memory" v={`${n(r?.cpu, '%')} / ${n(r?.memPct, '%')}`} />
            <Fact k="LAN" v={n(r?.lanSpeed, ' Mbps')} />
            <Fact k="Security" v={r?.security || '–'} />
          </div>
        </div>

        <div className="row-actions">
          <b>History</b>
          <div className="seg">
            {RANGES.map((h) => (
              <button key={h} className={h === hours ? 'on' : ''} onClick={() => setHours(h)}>
                {h >= 48 ? `${h / 24}d` : `${h}h`}
              </button>
            ))}
          </div>
          <span className="hint">{hist.length} samples</span>
        </div>

        <div className="charts">
          <LineChart
            title="Ping from this PC"
            unit="ms"
            hours={hours}
            data={series((x) => x.ping.avg)}
            threshold={thresholds.latencyMs}
            min={0}
            extra={(i) => (hist[i] ? `worst ${n(hist[i].ping.max, ' ms')} · loss ${n(hist[i].ping.lossPct, '%')}` : null)}
          />
          <LineChart title="Packet loss" unit="%" hours={hours} data={series((x) => x.ping.lossPct)} min={0} max={100} />
          {role === 'backbone-sta' && (
            <>
              <LineChart title="Signal" unit="dBm" hours={hours} data={series((x) => x.radio?.signal)} />
              <LineChart title="airMAX capacity" unit="%" hours={hours} data={series((x) => x.radio?.airmaxCapacity)} threshold={thresholds.backboneCapacity} max={100} />
              <LineChart title="TX rate (back towards the house)" unit="Mbps" hours={hours} data={series((x) => x.radio?.txRate)} min={0} />
            </>
          )}
          {role !== 'ap' && (
            <LineChart title="CCQ" unit="%" hours={hours} data={series((x) => x.radio?.ccq)} threshold={thresholds.backboneCcq} max={100} digits={1} />
          )}
          <LineChart title="Noise floor" unit="dBm" hours={hours} data={series((x) => x.radio?.noise)} threshold={role === 'ap' ? thresholds.apNoise : undefined} />
          {role === 'ap' && (
            <>
              <LineChart title="Connected devices" unit="" hours={hours} data={series((x) => x.stations?.count)} min={0} />
              <LineChart title={`Devices weaker than ${thresholds.weakSignal} dBm`} unit="" hours={hours} data={series((x) => x.stations?.weak)} min={0} />
            </>
          )}
        </div>

        {stations.length > 0 && (
          <div className="card">
            <div className="card-h">
              <h2>Connected now</h2>
              <span className="sub">Weakest first. "Signal" is how strongly this radio hears the device.</span>
            </div>
            <div className="card-b tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>MAC</th>
                    <th>IP</th>
                    <th>Signal</th>
                    <th className="r">Down / up Mbps</th>
                    <th className="r">CCQ</th>
                    <th className="r">Latency</th>
                    <th className="r">Distance</th>
                    <th className="r">Connected</th>
                  </tr>
                </thead>
                <tbody>
                  {stations.map((st) => {
                    const c = sigClass(st.signal, thresholds.weakSignal);
                    const pct = st.signal === null ? 0 : Math.max(0, Math.min(100, ((st.signal + 95) / 50) * 100));
                    return (
                      <tr key={st.mac}>
                        <td className="mono">{st.mac}</td>
                        <td className={`mono ${!st.ip ? 'weak' : ''}`}>{st.ip || 'none'}</td>
                        <td>
                          <span className="sig">
                            <span className="bar">
                              <span style={{ width: `${pct}%`, background: `var(--${c === 'unknown' ? 'text-3' : c})` }} />
                            </span>
                            <span className={c === 'critical' ? 'weak' : ''}>{n(st.signal, ' dBm')}</span>
                          </span>
                        </td>
                        <td className={`r ${(st.rxRate ?? 99) <= 6.5 ? 'weak' : ''}`}>
                          {n(st.txRate, '', 1)} / {n(st.rxRate, '', 1)}
                        </td>
                        <td className="r">{n(st.ccq, '%')}</td>
                        <td className="r">{n(st.latency, ' ms')}</td>
                        <td className="r">{st.distanceM ? `${(st.distanceM / 1000).toFixed(1)} km` : '–'}</td>
                        <td className="r">{duration(st.uptime)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <details
          className="card"
          onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && api.raw(id).then(setRaw).catch(() => undefined)}
        >
          <summary className="card-h" style={{ cursor: 'pointer' }}>
            <h2>Raw data from the radio</h2>
            <span className="sub">for troubleshooting</span>
          </summary>
          <div className="card-b">
            <pre className="raw">{raw ? JSON.stringify(raw, null, 2) : 'Loading…'}</pre>
          </div>
        </details>
      </aside>
    </>
  );
}

function Fact({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="kv">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
    </div>
  );
}
