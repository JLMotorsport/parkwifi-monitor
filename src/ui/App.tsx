import { useCallback, useEffect, useState } from 'react';
import type { AppState, Thresholds } from '../core/types';
import { api } from './api';
import { applyTheme, loadTheme, saveTheme, type Theme } from './derive';
import { ago } from './format';
import { AlertsPage } from './components/Alerts';
import { ClientsPage } from './components/Clients';
import { DevicesPage, type DevFilter } from './components/Devices';
import { Icon } from './components/Icon';
import { Overview } from './components/Overview';
import { StatusIcon, worst } from './components/Pill';
import { Settings } from './components/Settings';

type Page = 'dashboard' | 'devices' | 'clients' | 'alerts' | 'settings';

const NAV: [Page, string, string][] = [
  ['dashboard', 'Dashboard', 'dashboard'],
  ['devices', 'Devices', 'devices'],
  ['clients', 'Clients', 'clients'],
  ['alerts', 'Alerts', 'bell'],
];

const THEME_NEXT: Record<Theme, Theme> = { system: 'light', light: 'dark', dark: 'system' };
const THEME_ICON: Record<Theme, string> = { system: 'monitor', light: 'sun', dark: 'moon' };
const THEME_LABEL: Record<Theme, string> = { system: 'Theme: follows Windows', light: 'Theme: light', dark: 'Theme: dark' };

export function App() {
  const [s, setS] = useState<AppState | null>(null);
  const [err, setErr] = useState('');
  const [page, setPage] = useState<Page>('dashboard');
  const [sel, setSel] = useState<string | null>(null);
  const [toastMsg, setToast] = useState('');
  const [th, setTh] = useState<Thresholds | null>(null);
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const [devFilter, setDevFilter] = useState<DevFilter>('all');
  const [query, setQuery] = useState('');
  const [weakOnly, setWeakOnly] = useState(false);

  useEffect(() => {
    applyTheme(theme);
    saveTheme(theme);
  }, [theme]);

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
    if (s?.needsSetup) setPage('settings');
  }, [s?.needsSetup]);

  const go = (p: Page) => {
    setPage(p);
    setQuery('');
    window.scrollTo(0, 0);
  };
  const open = (id: string) => {
    setSel(id);
    setDevFilter('all');
    go('devices');
  };

  if (!s)
    return (
      <div className="content">
        {err ? <div className="banner bad">Can't reach the monitor: {err}</div> : <div className="empty">Loading…</div>}
      </div>
    );

  const crit = s.alerts.filter((a) => a.severity !== 'warning').length;
  const warn = s.alerts.length - crit;
  const overall = worst(s.alerts.map((a) => a.severity));
  const enabled = s.devices.filter((d) => d.cfg.enabled);

  return (
    <div className="shell">
      <nav className="rail" aria-label="Main">
        <div className="logo" aria-hidden>
          <Icon name="wifi" size={20} stroke={2.2} color="#fff" />
        </div>
        {NAV.map(([k, label, icon]) => (
          <button key={k} className={`navbtn ${page === k ? 'on' : ''}`} aria-label={label} aria-current={page === k ? 'page' : undefined} onClick={() => go(k)}>
            <Icon name={icon} />
            {k === 'alerts' && s.alerts.length > 0 && <span className="badge">{s.alerts.length}</span>}
            <span className="tip">{label}</span>
          </button>
        ))}
        <span className="grow" />
        <button className={`navbtn ${page === 'settings' ? 'on' : ''}`} aria-label="Settings" aria-current={page === 'settings' ? 'page' : undefined} onClick={() => go('settings')}>
          <Icon name="settings" />
          <span className="tip">Settings</span>
        </button>
      </nav>

      <div className="page">
        <header className="topbar">
          <Crumb page={page} s={s} />
          {page === 'dashboard' && (
            <span className={`pill ${s.alerts.length ? overall : 'good'}`}>
              <StatusIcon h={s.alerts.length ? overall : 'good'} />
              {s.alerts.length ? [crit && `${crit} problem${crit === 1 ? '' : 's'}`, warn && `${warn} warning${warn === 1 ? '' : 's'}`].filter(Boolean).join(', ') : 'All good'}
            </span>
          )}
          {page === 'devices' && (
            <>
              <span className="faint">{enabled.length} radios</span>
              <div className="seg" role="group" aria-label="Filter">
                {(
                  [
                    ['all', 'All'],
                    ['backbone', 'Backbone'],
                    ['ap', 'Access points'],
                  ] as [DevFilter, string][]
                ).map(([k, l]) => (
                  <button key={k} className={devFilter === k ? 'on' : ''} onClick={() => setDevFilter(k)}>
                    {l}
                  </button>
                ))}
              </div>
            </>
          )}
          {page === 'clients' && (
            <div className="seg" role="group" aria-label="Filter">
              <button className={!weakOnly ? 'on' : ''} onClick={() => setWeakOnly(false)}>
                All
              </button>
              <button className={weakOnly ? 'on' : ''} onClick={() => setWeakOnly(true)}>
                Weak signal
              </button>
            </div>
          )}
          <span className="spacer" />
          {(page === 'devices' || page === 'clients') && (
            <label className="search">
              <Icon name="search" size={14} stroke={2} />
              <input aria-label="Search" placeholder={page === 'devices' ? 'Search name or IP' : 'Search MAC, IP or AP'} value={query} onChange={(e) => setQuery(e.target.value)} />
            </label>
          )}
          <span className="pollinfo hide-sm">{s.polling ? 'Polling…' : `Polled ${ago(s.lastPoll, s.now)}`}</span>
          <button className="btn icon" title={THEME_LABEL[theme]} aria-label={THEME_LABEL[theme]} onClick={() => setTheme(THEME_NEXT[theme])}>
            <Icon name={THEME_ICON[theme]} size={16} />
          </button>
          <a className="btn" href="./api/export?hours=48" download title="Save the last 48 hours as one file you can send to Claude">
            <Icon name="download" size={14} stroke={2} />
            Export
          </a>
          <button
            className="btn primary"
            disabled={s.polling}
            onClick={() => {
              api.poll().then(() => setTimeout(load, 500));
            }}
          >
            Poll now
          </button>
        </header>

        <main className="content">
          {err && <div className="banner bad">Lost contact with the monitor: {err}</div>}
          {s.needsSetup && page !== 'settings' && (
            <div className="banner">
              Enter the radios' airOS login in Settings to start reading signal and client data. Pings already run.
              <button className="btn small" onClick={() => go('settings')}>
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
          {page === 'dashboard' && <Overview s={s} open={open} goto={go} latencyLimit={th?.latencyMs ?? 40} />}
          {page === 'devices' && <DevicesPage s={s} sel={sel} setSel={setSel} thresholds={th} filter={devFilter} query={query} />}
          {page === 'clients' && <ClientsPage s={s} open={open} thresholds={th} weakOnly={weakOnly} query={query} />}
          {page === 'alerts' && <AlertsPage s={s} open={open} />}
          {page === 'settings' && (
            <Settings
              s={s}
              toast={setToast}
              theme={theme}
              setTheme={setTheme}
              onSaved={() => {
                load();
                api.config().then((c) => setTh(c.thresholds));
              }}
            />
          )}
        </main>
      </div>
      {toastMsg && (
        <div className="toast" role="status">
          {toastMsg}
        </div>
      )}
    </div>
  );
}

function Crumb({ page, s }: { page: Page; s: AppState }) {
  const titles: Record<Page, string> = { dashboard: 'Priory Park', devices: 'Devices', clients: 'Clients', alerts: 'Alerts', settings: 'Settings' };
  const clients = s.devices.filter((d) => d.role === 'ap').reduce((a, d) => a + (d.latest?.stations?.count ?? 0), 0);
  return (
    <div className="crumb">
      <b>{titles[page]}</b>
      {page === 'dashboard' && (
        <>
          <span className="sep hide-sm">/</span>
          <span className="sub hide-sm">Lookout &amp; Monks Meadow</span>
        </>
      )}
      {page === 'clients' && <span className="faint">{clients} connected</span>}
      {page === 'settings' && <span className="faint">Version {s.version}</span>}
    </div>
  );
}
