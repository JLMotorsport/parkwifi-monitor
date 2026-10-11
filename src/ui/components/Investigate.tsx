import { useState } from 'react';
import type { AppState, Talker, TraceResult } from '../../core/types';
import { api } from '../api';
import { ago, clock, n } from '../format';
import { StatusIcon } from './Pill';
import { BlockButton, blockedOn } from './Blocking';

const SPIKE_MS = 50;

const talkerLabel = (t: Talker) => t.name || t.vendor || 'Unknown device';
const matchLabel = (m: number | null) => (m === null ? 'Too early' : m >= 0.6 ? 'Strong' : m >= 0.3 ? 'Some' : 'No');

/** Devices ranked by how much they send, with likely flood sources first. */
export function TalkersCard({ s, open, toast }: { s: AppState; open: (id: string) => void; toast?: (m: string) => void }) {
  const [copied, setCopied] = useState('');
  const list = s.talkers.slice(0, 10);
  const flood = s.gateways.find((g) => g.cfg.enabled)?.latest?.gw?.watch?.floodPps ?? null;
  const copy = (mac: string) => {
    void navigator.clipboard?.writeText(mac).then(() => {
      setCopied(mac);
      setTimeout(() => setCopied(''), 1500);
    });
  };
  return (
    <section className="card">
      <div className="card-h">
        <h2>Who is sending the most</h2>
        <span className="sub">
          Every device on the access points, by packets it sends a second. Devices that broadcast send far more than they get back, and rise and fall with the flood
          figure on UDR3{flood != null ? ` (${flood}/s now)` : ''}.
        </span>
      </div>
      {!list.length ? (
        <div className="empty">Readings start after two polls of each access point.</div>
      ) : (
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Device</th>
                <th>MAC</th>
                <th>Access point</th>
                <th className="r">Sends /s</th>
                <th className="r">Gets /s</th>
                <th className="r">Follows flood</th>
                <th>Verdict</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {list.map((t) => (
                <tr key={t.mac}>
                  <td>
                    <b>{talkerLabel(t)}</b>
                    {t.name && t.vendor && <div className="faint">{t.vendor}</div>}
                    {t.ip && <div className="faint mono">{t.ip}</div>}
                  </td>
                  <td>
                    <button className="linkbtn mono" title="Copy MAC for the MAC ACL" onClick={() => copy(t.mac)}>
                      {copied === t.mac ? 'Copied' : t.mac}
                    </button>
                  </td>
                  <td>
                    <button className="linkbtn" onClick={() => open(t.apId)}>
                      {t.apName}
                    </button>
                    <div className="faint">{n(t.signal, ' dBm')}</div>
                  </td>
                  <td className="r">
                    <b>{t.sentPps}</b> <span className="faint">peak {t.sentPeakPps}</span>
                  </td>
                  <td className="r">{t.recvPps}</td>
                  <td className="r">{matchLabel(t.floodMatch)}</td>
                  <td style={{ whiteSpace: 'normal', minWidth: 220 }}>
                    {t.suspect ? (
                      <>
                        <span className="pill warning">
                          <StatusIcon h="warning" />
                          Likely flood source
                        </span>
                        <div className="hint" style={{ marginTop: 4 }}>
                          {t.suspect}
                        </div>
                      </>
                    ) : (
                      <span className="faint">Normal</span>
                    )}
                  </td>
                  <td className="r">
                    {(t.suspect || blockedOn(s, t.mac).length > 0) && <BlockButton s={s} mac={t.mac} apId={t.apId} apName={t.apName} toast={toast} />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Starts a 30 s path test to one radio; the result arrives with the next state update. */
export function TraceButton({ s, id, toast }: { s: AppState; id: string; toast?: (m: string) => void }) {
  const running = s.traceRunning;
  return (
    <button
      className="btn"
      disabled={!!running}
      title="Pings every hop from this PC to this radio once a second for 30 seconds, then says where delay spikes start"
      onClick={() => api.trace(id).catch((e) => toast?.(String((e as Error).message).replace(/^\d+ /, '')))}
    >
      {running === id ? 'Testing the path… 30 s' : running ? 'Another test is running' : 'Find where delay comes from (30 s)'}
    </button>
  );
}

export function TraceCard({ t, now, open }: { t: TraceResult; now: number; open?: (id: string) => void }) {
  const h = t.spikes < 3 ? 'good' : t.culprit === null ? 'warning' : 'serious';
  return (
    <div className="trace">
      <div className="trace-h">
        <span className={`pill ${h}`}>
          <StatusIcon h={h} />
          {t.spikes < 3 ? 'No spikes' : t.culprit === null ? `${t.spikes} spikes, no single source` : `${t.spikes} spikes, source found`}
        </span>
        <b>
          Path to{' '}
          {open ? (
            <button className="linkbtn" onClick={() => open(t.targetId)}>
              {t.targetName}
            </button>
          ) : (
            t.targetName
          )}
        </b>
        <span className="faint">
          {clock(t.startedAt)} · {ago(t.startedAt, now)} · {t.reason === 'alert' ? 'run by a slow-reply alert' : 'run by you'}
        </span>
      </div>
      <p className="trace-v">{t.verdict}</p>
      <div className="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Hop</th>
              <th className="r">Typical</th>
              <th className="r">Adds</th>
              <th className="r">Bad moments</th>
              <th className="r">Worst</th>
              <th className="r">Lost</th>
              <th className="r">Spikes start here</th>
              <th style={{ minWidth: 200 }}>Each second</th>
            </tr>
          </thead>
          <tbody>
            {t.hops.map((hop, i) => (
              <tr key={hop.id} className={t.culprit === i ? 'culprit' : ''}>
                <td>
                  {t.culprit === i && <StatusIcon h="serious" />} {hop.name}
                </td>
                <td className="r">{n(hop.median, ' ms')}</td>
                <td className="r">{hop.addedMedian === null ? '–' : `+${Math.max(0, hop.addedMedian)} ms`}</td>
                <td className="r">{n(hop.p95, ' ms')}</td>
                <td className="r">{n(hop.worst, ' ms')}</td>
                <td className="r">{hop.lossPct}%</td>
                <td className="r">{hop.spikesStartHere || '–'}</td>
                <td>
                  <span className="strip" aria-hidden="true">
                    {hop.series.map((v, k) => (
                      <i key={k} className={v === null ? 'lost' : hop.median !== null && v - hop.median > SPIKE_MS ? 'spike' : 'ok'} title={v === null ? `${k + 1}s: no reply` : `${k + 1}s: ${v} ms`} />
                    ))}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="hint" style={{ padding: '6px 0 0' }}>
        Each second: light = normal, amber = a spike over {SPIKE_MS} ms above that hop's typical, dark red = no reply. A spike that starts at one hop and carries on
        to every hop after it was added on the link into that hop.
      </div>
    </div>
  );
}

export function TracesCard({ s, open, only }: { s: AppState; open?: (id: string) => void; only?: string }) {
  const list = s.traces.filter((t) => !only || t.targetId === only);
  if (!list.length && !s.traceRunning) return null;
  return (
    <section className="card">
      <div className="card-h">
        <h2>Path tests</h2>
        <span className="sub">Run automatically when a radio starts replying slowly (at most every 20 minutes), or from a radio's panel.</span>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 18 }}>
        {s.traceRunning && <div className="hint">Testing the path to {s.devices.find((d) => d.cfg.id === s.traceRunning)?.cfg.name ?? s.traceRunning}: about 30 seconds…</div>}
        {list.slice(0, 3).map((t) => (
          <TraceCard key={t.id} t={t} now={s.now} open={open} />
        ))}
      </div>
    </section>
  );
}
