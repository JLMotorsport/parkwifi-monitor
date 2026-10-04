import { useEffect, useState } from 'react';
import type { AppState, DeviceCfg, PublicConfig, Role } from '../../core/types';
import { api } from '../api';
import type { Theme } from '../derive';
import { roleLabel } from '../format';

export function Settings({ s, toast, onSaved, theme, setTheme }: { s: AppState; toast: (m: string) => void; onSaved: () => void; theme: Theme; setTheme: (t: Theme) => void }) {
  const [c, setC] = useState<PublicConfig | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState('');
  const [tests, setTests] = useState<Record<string, string>>({});

  useEffect(() => {
    api.config().then(setC).catch((e) => toast(String(e)));
  }, []);

  if (!c) return <div className="empty">Loading settings…</div>;

  const set = <K extends keyof PublicConfig>(k: K, v: PublicConfig[K]) => setC({ ...c, [k]: v });
  const th = <K extends keyof PublicConfig['thresholds']>(k: K, v: number) => set('thresholds', { ...c.thresholds, [k]: v });
  const dev = (i: number, patch: Partial<DeviceCfg>) => set('devices', c.devices.map((d, j) => (j === i ? { ...d, ...patch } : d)));

  const save = async () => {
    setBusy('save');
    try {
      const out = await api.saveConfig({ ...c, ...(password ? { password } : {}) });
      setC(out);
      setPassword('');
      toast('Saved. Polling again now.');
      await api.poll();
      onSaved();
    } catch (e) {
      toast('Save failed: ' + String(e));
    } finally {
      setBusy('');
    }
  };

  const test = async (ip: string) => {
    setTests((t) => ({ ...t, [ip]: 'testing…' }));
    const r = await api.test(ip).catch((e) => ({ ok: false, message: String(e) }));
    setTests((t) => ({ ...t, [ip]: (r.ok ? '✓ ' : '× ') + r.message }));
  };

  const discover = async () => {
    setBusy('discover');
    toast('Scanning 192.168.2.1 to .254. This takes about a minute.');
    try {
      const r = await api.discover('192.168.2');
      toast(r.added.length ? `Found ${r.added.length} new radio(s): ${r.added.map((a) => a.name).join(', ')}` : 'No new radios found.');
      setC(await api.config());
      onSaved();
    } catch (e) {
      toast('Scan failed: ' + String(e));
    } finally {
      setBusy('');
    }
  };

  const chainMove = (i: number, dir: -1 | 1) => {
    const arr = [...c.chain];
    const j = i + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[i], arr[j]] = [arr[j], arr[i]];
    set('chain', arr);
  };
  const backboneCandidates = c.devices.filter((d) => !c.chain.includes(d.id));
  const name = (id: string) => c.devices.find((d) => d.id === id)?.name ?? id;
  const remoteUrl = `http://<this PC's IP>:${c.server.port}/?token=${c.server.token}`;

  return (
    <>
      <div className="row-actions savebar">
        <button className="btn primary" onClick={save} disabled={!!busy}>
          {busy === 'save' ? 'Saving…' : 'Save settings'}
        </button>
        <span className="hint">Changes apply on the next poll.</span>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Radio login</h2>
          <span className="sub">The airOS username and password, the same on every radio. Stored encrypted on this PC.</span>
        </div>
        <div className="card-b form">
          <label className="f">
            Username
            <input value={c.username} onChange={(e) => set('username', e.target.value)} />
          </label>
          <label className="f">
            Password {c.hasPassword && <span className="faint">(saved; leave blank to keep)</span>}
            <input type="password" value={password} placeholder={c.hasPassword ? '••••••••' : 'required'} onChange={(e) => setPassword(e.target.value)} />
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Radios</h2>
          <span className="sub">Role "Auto" works it out from the radio's wireless mode.</span>
          <span style={{ flex: 1 }} />
          <button className="btn small" onClick={discover} disabled={!!busy}>
            {busy === 'discover' ? 'Scanning…' : 'Discover radios'}
          </button>
          <button
            className="btn small"
            onClick={() => set('devices', [...c.devices, { id: 'radio-' + Date.now().toString(36), name: 'New radio', ip: '192.168.2.', site: 'Lookout', role: 'auto', enabled: true }])}
          >
            Add
          </button>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>On</th>
                <th>Name</th>
                <th>IP</th>
                <th>Site</th>
                <th>Role</th>
                <th>Login test</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.devices.map((d, i) => (
                <tr key={d.id}>
                  <td>
                    <input type="checkbox" checked={d.enabled} onChange={(e) => dev(i, { enabled: e.target.checked })} style={{ width: 'auto' }} />
                  </td>
                  <td style={{ minWidth: 200 }}>
                    <input value={d.name} onChange={(e) => dev(i, { name: e.target.value })} />
                  </td>
                  <td style={{ minWidth: 130 }}>
                    <input className="mono" value={d.ip} onChange={(e) => dev(i, { ip: e.target.value.trim() })} />
                  </td>
                  <td style={{ minWidth: 130 }}>
                    <input value={d.site} onChange={(e) => dev(i, { site: e.target.value })} />
                  </td>
                  <td>
                    <select value={d.role} onChange={(e) => dev(i, { role: e.target.value as Role | 'auto' })}>
                      <option value="auto">Auto</option>
                      {(['backbone-ap', 'backbone-sta', 'ap'] as Role[]).map((r) => (
                        <option key={r} value={r}>
                          {roleLabel[r]}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <button className="btn small" onClick={() => test(d.ip)}>
                      Test
                    </button>{' '}
                    <span className="hint">{tests[d.ip]}</span>
                  </td>
                  <td>
                    <button
                      className="btn small danger"
                      onClick={() => setC({ ...c, devices: c.devices.filter((_, j) => j !== i), chain: c.chain.filter((x) => x !== d.id) })}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Backbone order</h2>
          <span className="sub">From the house outwards. Used for the backbone diagram and the "added by hop" figures.</span>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 6 }}>
          {c.chain.map((id, i) => (
            <div key={id} className="row-actions">
              <span className="faint num" style={{ width: 18 }}>
                {i + 1}
              </span>
              <b style={{ minWidth: 220 }}>{name(id)}</b>
              <button className="btn small" onClick={() => chainMove(i, -1)} disabled={i === 0} aria-label="Move up">
                ↑
              </button>
              <button className="btn small" onClick={() => chainMove(i, 1)} disabled={i === c.chain.length - 1} aria-label="Move down">
                ↓
              </button>
              <button className="btn small danger" onClick={() => set('chain', c.chain.filter((x) => x !== id))}>
                Remove
              </button>
            </div>
          ))}
          {backboneCandidates.length > 0 && (
            <label className="f" style={{ maxWidth: 320, marginTop: 6 }}>
              Add to backbone
              <select value="" onChange={(e) => e.target.value && set('chain', [...c.chain, e.target.value])}>
                <option value="">Choose a radio…</option>
                {backboneCandidates.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.ip})
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Other things to ping</h2>
          <span className="sub">Routers or anything else worth watching. Ping only, no login.</span>
          <span style={{ flex: 1 }} />
          <button className="btn small" onClick={() => set('probes', [...c.probes, { id: 'probe-' + Date.now().toString(36), name: 'New target', host: '' }])}>
            Add
          </button>
        </div>
        <div className="tbl-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Address</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {c.probes.map((p, i) => (
                <tr key={p.id}>
                  <td style={{ minWidth: 220 }}>
                    <input value={p.name} onChange={(e) => set('probes', c.probes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  </td>
                  <td style={{ minWidth: 160 }}>
                    <input className="mono" value={p.host} onChange={(e) => set('probes', c.probes.map((x, j) => (j === i ? { ...x, host: e.target.value.trim() } : x)))} />
                  </td>
                  <td>
                    <button className="btn small danger" onClick={() => set('probes', c.probes.filter((_, j) => j !== i))}>
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Polling and alerts</h2>
        </div>
        <div className="card-b form">
          <Num label="Poll every (seconds)" v={c.pollSeconds} on={(v) => set('pollSeconds', v)} />
          <Num label="Pings per device per poll" v={c.pingCount} on={(v) => set('pingCount', v)} />
          <Num label="Ping size (bytes)" v={c.pingSize} on={(v) => set('pingSize', v)} />
          <Num label="Slow ping above (ms)" v={c.thresholds.latencyMs} on={(v) => th('latencyMs', v)} />
          <Num label="Packet loss above (%)" v={c.thresholds.lossPct} on={(v) => th('lossPct', v)} />
          <Num label="Backbone CCQ below (%)" v={c.thresholds.backboneCcq} on={(v) => th('backboneCcq', v)} />
          <Num label="Backbone capacity below (%)" v={c.thresholds.backboneCapacity} on={(v) => th('backboneCapacity', v)} />
          <Num label="Weak device signal (dBm)" v={c.thresholds.weakSignal} on={(v) => th('weakSignal', v)} />
          <Num label="AP noise floor above (dBm)" v={c.thresholds.apNoise} on={(v) => th('apNoise', v)} />
          <Num label="Bad polls before alerting" v={c.thresholds.sustainPolls} on={(v) => th('sustainPolls', v)} />
          <Num label="Keep history (days)" v={c.retentionDays} on={(v) => set('retentionDays', v)} />
          <Num label="Test each change for (minutes)" v={c.trialMinutes ?? 10} on={(v) => set('trialMinutes', v)} />
          <Num label="Radio SSH port (for changes)" v={c.sshPort ?? 22} on={(v) => set('sshPort', v)} />
          <label className="chk">
            <input type="checkbox" checked={c.notifications} onChange={(e) => set('notifications', e.target.checked)} /> Windows notifications for alerts
          </label>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Appearance</h2>
          <span className="sub">Saved on this PC. The moon/sun button in the header switches it too.</span>
        </div>
        <div className="card-b row-actions">
          <div className="seg" role="group" aria-label="Theme">
            {(
              [
                ['system', 'Follow Windows'],
                ['light', 'Light'],
                ['dark', 'Dark'],
              ] as [Theme, string][]
            ).map(([k, l]) => (
              <button key={k} className={theme === k ? 'on' : ''} onClick={() => setTheme(k)}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>App</h2>
          <span className="sub">Version {s.version}</span>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 12 }}>
          {s.autostart !== null && (
            <label className="chk">
              <input type="checkbox" checked={!!s.autostart} onChange={(e) => api.autostart(e.target.checked).then(onSaved)} /> Start with
              Windows (runs in the tray, window hidden)
            </label>
          )}
          <div className="row-actions">
            <span>
              Updates: <b>{updateText(s)}</b>
            </span>
            {s.update.status === 'ready' ? (
              <button className="btn primary small" onClick={() => api.installUpdate()}>
                Restart and update
              </button>
            ) : (
              <button className="btn small" onClick={() => api.checkUpdate().then(onSaved)} disabled={s.update.status === 'unsupported'}>
                Check now
              </button>
            )}
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Export data</h2>
          <span className="sub">
            One file with hourly stats for every radio, all alerts, restarts and channel changes, and each radio's latest raw data. No
            passwords. Attach it to a Claude chat for analysis.
          </span>
        </div>
        <div className="card-b row-actions">
          {[24, 48, 168, 720].map((h) => (
            <a key={h} className="btn small" href={`./api/export?hours=${h}`} download>
              Last {h >= 48 ? `${h / 24} days` : '24 hours'}
            </a>
          ))}
        </div>
      </div>

      <div className="card">
        <div className="card-h">
          <h2>Access from other devices</h2>
          <span className="sub">For later, when this runs on an always-on PC. Takes effect after restarting the app.</span>
        </div>
        <div className="card-b" style={{ display: 'grid', gap: 10 }}>
          <label className="chk">
            <input
              type="checkbox"
              checked={c.server.allowRemote}
              onChange={(e) => set('server', { ...c.server, allowRemote: e.target.checked })}
            />{' '}
            Allow other devices on the network to open the dashboard
          </label>
          {c.server.allowRemote && (
            <>
              <div className="hint">
                Open <span className="mono">{remoteUrl}</span> from a phone or laptop on the office network once. A token is required
                from any device other than this PC.
              </div>
              <div className="row-actions">
                <span className="mono">Token: {c.server.token}</span>
                <button
                  className="btn small"
                  onClick={() => set('server', { ...c.server, token: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('') })}
                >
                  New token
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function Num({ label, v, on }: { label: string; v: number; on: (v: number) => void }) {
  return (
    <label className="f">
      {label}
      <input type="number" value={v} onChange={(e) => on(Number(e.target.value))} />
    </label>
  );
}

function updateText(s: AppState) {
  const u = s.update;
  switch (u.status) {
    case 'checking':
      return 'checking…';
    case 'downloading':
      return `downloading ${u.version ?? ''} (${u.progress ?? 0}%)`;
    case 'ready':
      return `version ${u.version} is ready`;
    case 'none':
      return 'up to date';
    case 'error':
      return `couldn't check (${u.message ?? 'error'})`;
    case 'unsupported':
      return 'only in the installed app';
    default:
      return 'automatic';
  }
}
