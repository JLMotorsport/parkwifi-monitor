import { useState } from 'react';
import type { AppState, BlockJob, BlockStep } from '../../core/types';
import { api } from '../api';
import { ago, clock } from '../format';
import { StatusIcon } from './Pill';

const STEP_H: Record<BlockStep['state'], 'good' | 'warning' | 'critical' | 'unknown'> = {
  waiting: 'unknown',
  checking: 'unknown',
  applying: 'unknown',
  verifying: 'unknown',
  done: 'good',
  skipped: 'warning',
  undone: 'warning',
  failed: 'critical',
};
const STEP_LABEL: Record<BlockStep['state'], string> = {
  waiting: 'Waiting',
  checking: 'Checking',
  applying: 'Applying',
  verifying: 'Verifying',
  done: 'Done',
  skipped: 'Not changed',
  undone: 'Undone',
  failed: 'Failed',
};

export const blockedOn = (s: AppState, mac: string) => s.acl.blocked.find((b) => b.mac === mac.toUpperCase())?.aps ?? [];

/**
 * Block button for one device. Asks first: just the AP it is on, or every AP so it can't simply
 * move to the next one. Every AP is checked and the change undone if anything looks wrong.
 */
export function BlockButton({ s, mac, apId, apName, toast }: { s: AppState; mac: string; apId: string; apName: string; toast?: (m: string) => void }) {
  const [ask, setAsk] = useState(false);
  const [err, setErr] = useState('');
  const busy = !!s.acl.job && !s.acl.job.endedAt;
  const on = blockedOn(s, mac);
  const go = async (apIds?: string[]) => {
    try {
      setErr('');
      await api.block(mac, apIds);
      setAsk(false);
    } catch (e) {
      const m = String((e as Error).message).replace(/^\d+ /, '');
      setErr(m);
      toast?.(m);
    }
  };
  if (on.length) {
    return (
      <span className="pill unknown" title={on.map((a) => a.apName).join(', ')}>
        <StatusIcon h="unknown" />
        Blocked on {on.length === 1 ? on[0].apName : `${on.length} APs`}
      </span>
    );
  }
  if (!ask) {
    return (
      <button className="btn small" disabled={busy} title={busy ? 'Another block is running' : 'Block this device with the MAC ACL'} onClick={(e) => (e.stopPropagation(), setAsk(true))}>
        Block…
      </button>
    );
  }
  const others = s.devices.filter((d) => d.role === 'ap' && d.cfg.enabled && !s.chain.includes(d.cfg.id)).length;
  return (
    <span className="row-actions" onClick={(e) => e.stopPropagation()}>
      <button className="btn small primary" disabled={busy} onClick={() => go(undefined)} title="It can't just move to another AP">
        Block on all {others} APs
      </button>
      <button className="btn small" disabled={busy} onClick={() => go([apId])}>
        Only {apName}
      </button>
      <button className="btn small" onClick={() => setAsk(false)}>
        Cancel
      </button>
      {err && <span className="ink-critical">{err}</span>}
    </span>
  );
}

function JobView({ job, now }: { job: BlockJob; now: number }) {
  const running = !job.endedAt;
  const done = job.steps.filter((x) => x.state === 'done').length;
  return (
    <div className="job">
      <div className="trace-h">
        <b>
          {job.kind === 'block' ? 'Blocking' : 'Unblocking'} {job.label || job.mac} <span className="mono faint">{job.mac}</span>
        </b>
        <span className="faint">
          {running ? `started ${clock(job.startedAt)}, about a minute per AP, 4 at a time` : `${clock(job.endedAt!)} · ${ago(job.endedAt!, now)} · ${done} of ${job.steps.length} done`}
        </span>
      </div>
      <div className="tbl-wrap">
        <table>
          <tbody>
            {job.steps.map((st) => (
              <tr key={st.apId}>
                <td style={{ width: 200 }}>{st.apName}</td>
                <td style={{ width: 130 }}>
                  <span className={`pill ${STEP_H[st.state]}`}>
                    <StatusIcon h={STEP_H[st.state]} />
                    {STEP_LABEL[st.state]}
                  </span>
                </td>
                <td className="dim" style={{ whiteSpace: 'normal' }}>
                  {st.message}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function BlockedCard({ s, toast }: { s: AppState; toast?: (m: string) => void }) {
  const a = s.acl;
  const busy = !!a.job && !a.job.endedAt;
  const [err, setErr] = useState('');
  const unblock = async (mac: string, apIds: string[]) => {
    try {
      setErr('');
      await api.unblock(mac, apIds);
    } catch (e) {
      const m = String((e as Error).message).replace(/^\d+ /, '');
      setErr(m);
      toast?.(m);
    }
  };
  return (
    <section className="card">
      <div className="card-h">
        <h2>Blocked devices</h2>
        <span className="sub">
          Read from each AP's MAC ACL, so blocks made by hand show too{a.refreshedAt ? ` · checked ${ago(a.refreshedAt, s.now)}` : ''}
        </span>
        <span className="spacer" />
        <button className="btn small" disabled={a.refreshing} onClick={() => void api.aclRefresh()}>
          {a.refreshing ? 'Reading the APs…' : 'Check again'}
        </button>
      </div>
      <div className="card-b" style={{ display: 'grid', gap: 14 }}>
        {err && <div className="errbox">{err}</div>}
        {a.job && <JobView job={a.job} now={s.now} />}
        {a.blocked.length ? (
          <div className="tbl-wrap">
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>MAC</th>
                  <th>Blocked on</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {a.blocked.map((b) => (
                  <tr key={b.mac}>
                    <td>
                      <b>{b.label || 'Unknown device'}</b>
                    </td>
                    <td className="mono">{b.mac}</td>
                    <td style={{ whiteSpace: 'normal' }}>{b.aps.map((x) => x.apName).join(', ')}</td>
                    <td className="r">
                      <button className="btn small" disabled={busy} onClick={() => unblock(b.mac, b.aps.map((x) => x.apId))}>
                        Unblock
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">{a.refreshedAt ? 'Nothing is blocked on any AP.' : a.refreshing ? 'Reading the APs…' : 'Not checked yet.'}</div>
        )}
        {a.notes.length > 0 && (
          <div className="hint">
            {a.notes.map((x) => (
              <div key={x.apId}>
                <b>{x.apName}:</b> {x.note}
              </div>
            ))}
          </div>
        )}
        <div className="hint">
          Each AP is checked first and given a 5-minute undo timer on the radio itself. After the change the app checks the AP answers, the device is gone and its
          other devices came back; if not, it puts the AP back as it was. APs set to an allow list are never touched. SSH Server must be on (Services tab).
        </div>
      </div>
    </section>
  );
}
