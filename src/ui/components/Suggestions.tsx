import { useState } from 'react';
import type { AppState, ChangeTrial, Suggestion, TrialStats } from '../../core/types';
import { api } from '../api';
import { clock } from '../format';
import { Icon } from './Icon';
import { StatusIcon } from './Pill';

const SEV_LABEL: Record<Suggestion['severity'], string> = { critical: 'Urgent', serious: 'Problem', warning: 'Worth fixing', info: 'Good to know' };
const sevHealth = (s: Suggestion['severity']) => (s === 'info' ? 'unknown' : s);
const ACTIVE = new Set(['checking', 'applying', 'testing']);

export function SuggestionsPage({ s, open, toast }: { s: AppState; open: (id: string) => void; toast: (m: string) => void }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const running = !!s.trial && ACTIVE.has(s.trial.status);
  const appCan = s.suggestions.filter((x) => x.change);
  const onSite = s.suggestions.filter((x) => !x.change);

  const start = async (id: string) => {
    setBusy(true);
    try {
      await api.changeStart(id);
      setConfirming(null);
    } catch (e) {
      toast(String((e as Error).message).replace(/^\d+ /, ''));
    } finally {
      setBusy(false);
    }
  };

  const card = (x: Suggestion) => {
    const last = s.changes.find((c) => c.suggestionId === x.id);
    return (
      <div className="sug" key={x.id}>
        <div className={`sug-ic ${sevHealth(x.severity)}`}>
          <StatusIcon h={sevHealth(x.severity)} size={12} />
        </div>
        <div className="sug-body">
          <div className="sug-top">
            <b>{x.title}</b>
            <span className={`tag ink-${sevHealth(x.severity)}`}>{SEV_LABEL[x.severity]}</span>
          </div>
          {x.deviceId.startsWith('gw:') ? (
            <span className="faint">{x.deviceName}</span>
          ) : (
            <button className="linkbtn" onClick={() => open(x.deviceId)}>
              {x.deviceName}
            </button>
          )}
          <p className="why">{x.why}</p>
          <p className="fix">
            <b>Fix:</b> {x.fix}
          </p>
          {last && (
            <p className={`hint ${last.status === 'kept' ? 'ink-good' : ''}`}>
              Tried {clock(last.startedAt)}: {last.message}
            </p>
          )}
          {x.change && (
            <div className="row-actions" style={{ marginTop: 8 }}>
              {confirming === x.id ? (
                <>
                  <span>
                    Change {x.deviceName} now? Its devices drop for a few seconds, then it is tested and kept only if nothing gets worse.
                  </span>
                  <button className="btn primary" disabled={busy || running} onClick={() => start(x.id)}>
                    {busy ? 'Starting…' : 'Yes, test it'}
                  </button>
                  <button className="btn" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <button className="btn primary" disabled={running} title={running ? 'One change at a time' : undefined} onClick={() => setConfirming(x.id)}>
                  <Icon name="wrench" size={14} stroke={2} />
                  {x.changeLabel ?? 'Apply'}
                  {last?.status === 'reverted' ? ' again' : ''}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };

  return (
    <>
      {s.trial && <TrialCard t={s.trial} now={s.now} toast={toast} />}

      <section className="card">
        <div className="card-h">
          <h2>The app can fix these</h2>
          <span className="sub">Access points only. Each change is tested, then kept or undone automatically.</span>
        </div>
        {appCan.length ? <div className="suglist">{appCan.map(card)}</div> : <div className="empty">Nothing to change on the access points right now.</div>}
      </section>

      <section className="card">
        <div className="card-h">
          <h2>Needs you</h2>
          <span className="sub">Backbone radios, hardware and anything a setting can't fix</span>
        </div>
        {onSite.length ? <div className="suglist">{onSite.map(card)}</div> : <div className="empty">Nothing else to report.</div>}
      </section>

      {s.changes.length > 0 && (
        <section className="card">
          <div className="card-h">
            <h2>Changes made</h2>
          </div>
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Radio</th>
                  <th>Change</th>
                  <th>Result</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {s.changes.map((c) => (
                  <tr key={c.id}>
                    <td className="dim">{clock(c.startedAt)}</td>
                    <td>{c.deviceName}</td>
                    <td>
                      {c.title} <span className="faint">(was {fmtChange(c.before)})</span>
                    </td>
                    <td>
                      <span className={`pill ${c.status === 'kept' ? 'good' : c.status === 'failed' ? 'unknown' : 'warning'}`}>
                        <StatusIcon h={c.status === 'kept' ? 'good' : c.status === 'failed' ? 'unknown' : 'warning'} />
                        {c.status === 'kept' ? 'Kept' : c.status === 'failed' ? 'Not made' : 'Undone'}
                      </span>
                    </td>
                    <td className="dim" style={{ whiteSpace: 'normal', minWidth: 260 }}>
                      {c.message}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <p className="hint" style={{ margin: 0 }}>
        Changes are made over SSH with the same login as the web page, so SSH Server must be on (Services tab) on each access point. Before writing
        anything the app checks the radio, then arms a timer on the radio that puts the old settings back by itself if the test isn't finished, even if
        this PC goes off.
      </p>
    </>
  );
}

function fmtChange(c: { txPower?: number; frequency?: number }) {
  const parts: string[] = [];
  if (c.txPower != null) parts.push(`${c.txPower} dBm`);
  if (c.frequency != null) parts.push(`ch ${(c.frequency - 2407) / 5}`);
  return parts.join(', ') || '?';
}

function TrialCard({ t, now, toast }: { t: ChangeTrial; now: number; toast: (m: string) => void }) {
  const active = ACTIVE.has(t.status);
  const [busy, setBusy] = useState(false);
  const left = t.trialEndsAt ? Math.max(0, Math.round((t.trialEndsAt - now) / 1000)) : null;
  const total = t.trialEndsAt ? (t.trialEndsAt - t.startedAt) / 1000 : 1;
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await f();
    } catch (e) {
      toast(String((e as Error).message).replace(/^\d+ /, ''));
    } finally {
      setBusy(false);
    }
  };
  const h = t.status === 'kept' ? 'good' : t.status === 'failed' ? 'unknown' : t.status === 'reverted' ? 'warning' : 'unknown';
  return (
    <section className={`card trial ${active ? 'on' : ''}`}>
      <div className="card-h">
        <h2>
          {active ? 'Testing' : t.status === 'kept' ? 'Kept' : t.status === 'failed' ? 'Not made' : 'Undone'}: {t.title} on {t.deviceName}
        </h2>
        {!active && (
          <span className={`pill ${h}`}>
            <StatusIcon h={h} />
            {t.endedAt ? clock(t.endedAt) : ''}
          </span>
        )}
        <span className="spacer" />
        {t.status === 'testing' && (
          <>
            <button className="btn" disabled={busy} onClick={() => act(api.changeUndo)}>
              Undo now
            </button>
            <button className="btn primary" disabled={busy} onClick={() => act(api.changeKeep)}>
              Keep it now
            </button>
          </>
        )}
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 12 }}>
        <div>{t.message}</div>
        {t.status === 'testing' && left !== null && (
          <div className="meter" style={{ maxWidth: 520 }}>
            <span className="trk">
              <span style={{ width: `${100 - (left / total) * 100}%`, background: 'var(--accent)' }} />
            </span>
            <span className="v" style={{ width: 'auto' }}>
              {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left
            </span>
          </div>
        )}
        {t.baseline && (
          <div className="tbl-wrap">
            <table style={{ maxWidth: 640 }}>
              <thead>
                <tr>
                  <th />
                  <th className="r">Online</th>
                  <th className="r">Ping</th>
                  <th className="r">Loss</th>
                  <th className="r">Devices</th>
                  <th className="r">Noise</th>
                  <th className="r">CCQ</th>
                  <th className="r">Setting</th>
                </tr>
              </thead>
              <tbody>
                <StatsRow label="Before" s={t.baseline} t={t} />
                {t.result && t.result.samples > 0 && <StatsRow label={active ? 'So far' : 'During test'} s={t.result} t={t} />}
              </tbody>
            </table>
          </div>
        )}
        {t.checks.length > 0 && (
          <div className="checks">
            {t.checks.map((c) => (
              <span key={c.name} className={`pill ${c.ok ? 'good' : 'critical'}`} title={c.detail}>
                <StatusIcon h={c.ok ? 'good' : 'critical'} />
                {c.name}: {c.detail}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function StatsRow({ label, s, t }: { label: string; s: TrialStats; t: ChangeTrial }) {
  const v = (x: number | null, u: string) => (x == null ? '–' : `${x}${u}`);
  return (
    <tr>
      <td>
        <b>{label}</b> <span className="faint">({s.samples} readings)</span>
      </td>
      <td className="r">{s.reachablePct}%</td>
      <td className="r">{v(s.pingAvg, ' ms')}</td>
      <td className="r">{v(s.lossAvg, '%')}</td>
      <td className="r">{v(s.clients, '')}</td>
      <td className="r">{v(s.noise, ' dBm')}</td>
      <td className="r">{v(s.ccq ?? null, '%')}</td>
      <td className="r">{t.change.txPower != null ? v(s.txPower, ' dBm') : s.frequency != null ? `ch ${(s.frequency - 2407) / 5}` : '–'}</td>
    </tr>
  );
}
