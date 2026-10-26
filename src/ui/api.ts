import type { AppState, ChangeTrial, PublicConfig, Sample, SpeedTestRecord } from '../core/types';

async function j<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  return r.json() as Promise<T>;
}

export const api = {
  state: () => j<AppState>('./api/state'),
  history: (id: string, hours: number) => j<Sample[]>(`./api/history?id=${encodeURIComponent(id)}&hours=${hours}`),
  raw: (id: string) => j<unknown>(`./api/raw?id=${encodeURIComponent(id)}`),
  config: () => j<PublicConfig>('./api/config'),
  saveConfig: (c: Partial<PublicConfig> & { password?: string }) => j<PublicConfig>('./api/config', { method: 'PUT', body: JSON.stringify(c) }),
  poll: () => j('./api/poll', { method: 'POST' }),
  test: (ip: string) => j<{ ok: boolean; message: string }>(`./api/test?ip=${encodeURIComponent(ip)}`, { method: 'POST' }),
  discover: (prefix: string) => j<{ added: { name: string; ip: string }[] }>(`./api/discover?prefix=${prefix}`, { method: 'POST' }),
  speedTests: (id: string) => j<SpeedTestRecord[]>(`./api/speedtests?id=${encodeURIComponent(id)}`),
  speedTest: (b: { from: string; to: string; direction: 'dx' | 'tx' | 'rx'; duration: number; port: number }) =>
    j<SpeedTestRecord>('./api/speedtest', { method: 'POST', body: JSON.stringify(b) }),
  block: (mac: string, apIds?: string[]) => j<unknown>('./api/block', { method: 'POST', body: JSON.stringify({ mac, apIds }) }),
  unblock: (mac: string, apIds?: string[]) => j<unknown>('./api/unblock', { method: 'POST', body: JSON.stringify({ mac, apIds }) }),
  aclRefresh: () => j<unknown>('./api/acl/refresh', { method: 'POST' }),
  trace: (id: string) => j<{ ok: boolean }>('./api/trace?id=' + encodeURIComponent(id), { method: 'POST' }),
  changeStart: (suggestion: string) => j<ChangeTrial>('./api/change/start', { method: 'POST', body: JSON.stringify({ suggestion }) }),
  changeKeep: () => j<ChangeTrial>('./api/change/keep', { method: 'POST' }),
  changeUndo: () => j<ChangeTrial>('./api/change/undo', { method: 'POST' }),
  testGateway: (id: string) => j<{ ok: boolean; message: string; ports: { idx: number; name: string; up: boolean }[]; networks?: string[] }>(`./api/gateway/test?id=${encodeURIComponent(id)}`, { method: 'POST' }),
  checkUpdate: () => j('./api/app/check-update', { method: 'POST' }),
  installUpdate: () => j('./api/app/install-update', { method: 'POST' }),
  autostart: (on: boolean) => j('./api/app/autostart', { method: 'POST', body: JSON.stringify({ on }) }),
};
