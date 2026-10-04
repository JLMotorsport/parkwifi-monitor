import { useCallback, useEffect, useState } from 'react';
import type { AppState, Thresholds } from '../core/types';
import { api } from './api';
import { ago } from './format';
import { AccessPoints } from './components/AccessPoints';
import { AlertsPage } from './components/Alerts';
import { DeviceDetail } from './components/DeviceDetail';
import { Overview } from './components/Overview';
import { Settings } from './components/Settings';

type Tab = 'overview' | 'aps' | 'alerts' | 'settings';

export function App() {
  const [s, setS] = useState<AppState | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const [open, setOpen] = useState<string | null>(null);
  const [toastMsg, setToast] = useState('');
  const [th, setTh] = useState<Thresholds | null>(null);

  const load = useCallback(() => {
    api
      .state()
      .then((x) => {
        setS(x);
        setErr('');
      })
      .catch((e) => setErr(String(e)));
  }, []);

  useEffect(() => {
    load();
    api.config().then((c) => setTh(c.thresholds)).catch(() => undefined);
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!toastMsg) return;
    const t = setTimeout(() => setToast(''), 5000);
    return () => clearTimeout(t);
  }, [toastMsg]);

  useEffect(() => {
    if (s?.needsSetup) setTab('settings');
  }, [s?.needsSetup]);

  if (!s) return <main>{err ? <div className="banner">Can't reach the monitor: {err}</div> : <div className="empty">Loading…</div>}</main>;

  const tabs: [Tab, string, number?][] = [
    ['overview', 'Overview'],
    ['aps', 'Access points'],
    ['alerts', 'Alerts', s.alerts.length],
    ['settings', 'Settings'],
  ];

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <img src="./favicon.png" alt="" />
          Park WiFi Monitor
        </div>
        <nav className="tabs">
          {tabs.map(([k, label, count]) => (
            <button key={k} className={`tab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>
              {label}
              {!!count && <span className="count">{count}</span>}
            </button>
          ))}
        </nav>
        <span className="spacer" />
        <span className="pollinfo">
          {s.polling ? 'Polling…' : `Polled ${ago(s.lastPoll, s.now)}`}
        </span>
        <button
          className="btn small"
          disabled={s.polling}
          onClick={() => {
            api.poll().then(() => setTimeout(load, 500));
          }}
        >
          Poll now
        </button>
      </header>
      <main>
        {err && <div className="banner">Lost contact with the monitor: {err}</div>}
        {s.needsSetup && tab !== 'settings' && (
          <div className="banner">
            Enter the radios' airOS login in Settings to start reading signal and client data. Pings already run.
            <button className="btn small" onClick={() => setTab('settings')}>
              Open Settings
            </button>
          </div>
        )}
        {s.update.status === 'ready' && (
          <div className="banner info">
            Version {s.update.version} has downloaded and installs on restart.
            <button className="btn primary small" onClick={() => api.installUpdate()}>
              Restart now
            </button>
          </div>
        )}
        {tab === 'overview' && <Overview s={s} open={setOpen} goto={setTab} />}
        {tab === 'aps' && <AccessPoints s={s} open={setOpen} />}
        {tab === 'alerts' && <AlertsPage s={s} open={setOpen} />}
        {tab === 'settings' && (
          <Settings
            s={s}
            toast={setToast}
            onSaved={() => {
              load();
              api.config().then((c) => setTh(c.thresholds));
            }}
          />
        )}
      </main>
      {open && th && <DeviceDetail s={s} id={open} close={() => setOpen(null)} thresholds={th} />}
      {toastMsg && <div className="toast">{toastMsg}</div>}
    </>
  );
}
