import { useEffect, useState } from 'react';
import type { AppState, SpeedTestRecord } from '../../core/types';
import { api } from '../api';
import { n } from '../format';

const DIR_LABEL = { dx: 'Both ways at once', tx: 'This radio → target', rx: 'Target → this radio' } as const;

/** Runs airOS's own Network Speed Test from this radio to another one. */
export function SpeedTestPanel({ s, id }: { s: AppState; id: string }) {
  const others = s.devices.filter((d) => d.cfg.id !== id && d.cfg.enabled);
  const me = s.devices.find((d) => d.cfg.id === id);
  const idx = s.chain.indexOf(id);
  const suggested = idx >= 0 && idx + 1 < s.chain.length ? s.chain[idx + 1] : s.chain[0] !== id ? s.chain[0] : others[0]?.cfg.id;
  const [to, setTo] = useState(suggested ?? '');
  const [dir, setDir] = useState<'dx' | 'tx' | 'rx'>('dx');
  const [dur, setDur] = useState(10);
  const [port, setPort] = useState(80);
  const [rows, setRows] = useState<SpeedTestRecord[]>([]);
  const [err, setErr] = useState('');
  const running = s.speedTestRunning;

  const load = () => api.speedTests(id).then(setRows).catch(() => undefined);
  useEffect(() => {
    load();
    api.config().then((c) => c.speedTestPort && setPort(c.speedTestPort)).catch(() => undefined);
  }, [id]);
  useEffect(() => {
    if (!running) load();
  }, [running]);

  const run = async () => {
    setErr('');
    try {
      await api.speedTest({ from: id, to, direction: dir, duration: dur, port });
    } catch (e) {
      setErr(String(e).replace(/^Error: \d+ /, ''));
    }
    load();
  };

  if (!me?.latest?.radio) return null;

  return (
    <div className="card">
      <div className="card-h">
        <h2>Speed test</h2>
        <span className="sub">
          Uses the radios' own test. It fills every link between the two radios while it runs, so pick a quiet moment.
        </span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        <div className="form">
          <label className="f">
            To
            <select value={to} onChange={(e) => setTo(e.target.value)}>
              {others.map((d) => (
                <option key={d.cfg.id} value={d.cfg.id}>
                  {d.cfg.name} ({d.cfg.ip})
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Direction
            <select value={dir} onChange={(e) => setDir(e.target.value as 'dx' | 'tx' | 'rx')}>
              {(['dx', 'tx', 'rx'] as const).map((k) => (
                <option key={k} value={k}>
                  {DIR_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="f">
            Seconds
            <input type="number" min={5} max={60} value={dur} onChange={(e) => setDur(Number(e.target.value))} />
          </label>
          <label className="f">
            Target's web port (http)
            <input type="number" value={port} onChange={(e) => setPort(Number(e.target.value))} />
          </label>
        </div>
        <div className="row-actions">
          <button className="btn primary" onClick={run} disabled={!!running || !to}>
            {running === id ? `Running… (about ${dur + 5}s)` : running ? 'Another test is running' : 'Run speed test'}
          </button>
          {err && <span className="weak">{err}</span>}
        </div>
        {rows.length > 0 && (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>From → to</th>
                  <th>Direction</th>
                  <th className="r">Out (Mbps)</th>
                  <th className="r">Back (Mbps)</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.t + r.fromId}>
                    <td>{new Date(r.t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</td>
                    <td>
                      {r.fromName} → {r.toName}
                    </td>
                    <td>{DIR_LABEL[r.direction]}</td>
                    <td className="r">
                      <b>{r.ok ? n(r.tx, '', 1) : '–'}</b>
                    </td>
                    <td className="r">
                      <b>{r.ok ? n(r.rx, '', 1) : '–'}</b>
                    </td>
                    <td style={{ whiteSpace: 'normal', minWidth: 220 }} className={r.ok ? '' : 'weak'}>
                      {r.ok ? 'OK' : r.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
