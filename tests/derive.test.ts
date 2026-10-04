import { describe, expect, it } from 'vitest';
import type { AppState, DeviceState } from '../src/core/types';
import { estInternet } from '../src/ui/derive';

const ping = (avg: number | null, lossPct = 0, received = 5) => ({ sent: 5, received, lossPct, avg, min: avg, max: avg });
const dev = (avg: number | null, lossPct = 0, received = 5) =>
  ({ cfg: { id: 'x', name: 'x', ip: '1', site: 's', role: 'auto', enabled: true }, role: 'backbone-sta', health: 'good', latest: { t: 0, id: 'x', ping: ping(avg, lossPct, received) } }) as DeviceState;
const state = (net: ReturnType<typeof ping> | undefined) =>
  ({ probes: [{ probe: { id: 'internet', name: 'Internet', host: '8.8.8.8' }, latest: net ? { t: 0, id: 'probe:internet', ping: net } : undefined }] }) as unknown as AppState;

describe('estInternet', () => {
  it('adds the backbone ping to the office internet ping', () => {
    expect(estInternet(state(ping(12)), dev(60))).toEqual({ ms: 72, lossPct: 0 });
  });
  it('combines loss on both legs', () => {
    expect(estInternet(state(ping(12, 20)), dev(60, 20))?.lossPct).toBe(36);
  });
  it('gives nothing when either leg has no reply', () => {
    expect(estInternet(state(ping(null, 100, 0)), dev(60))).toBeNull();
    expect(estInternet(state(ping(12)), dev(null, 100, 0))).toBeNull();
    expect(estInternet(state(undefined), dev(60))).toBeNull();
  });
});
