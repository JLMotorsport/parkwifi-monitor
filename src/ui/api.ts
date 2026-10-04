import type { AppState, PublicConfig, Sample } from '../core/types';

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
  checkUpdate: () => j('./api/app/check-update', { method: 'POST' }),
  installUpdate: () => j('./api/app/install-update', { method: 'POST' }),
  autostart: (on: boolean) => j('./api/app/autostart', { method: 'POST', body: JSON.stringify({ on }) }),
};
