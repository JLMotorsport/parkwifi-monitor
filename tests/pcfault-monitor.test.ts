// Poll-loop wiring: when the PC's own connection is bad, one PC alert, no radio alerts,
// and the readings are marked so stats and charts can leave them out.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PingResult } from '../src/core/types';

const net = { slow: false };
const res = (avg: number | null, loss: number): PingResult => ({ sent: 5, received: avg === null ? 0 : 5, lossPct: loss, avg, min: avg, max: avg });
vi.mock('../src/core/ping', () => ({
  ping: async () => (net.slow ? res(280, 30) : res(8, 0)),
  reach: async (host: string) => (net.slow ? res(290, 40) : host === '8.8.8.8' ? res(13, 0) : res(3, 0)),
}));

const { Monitor } = await import('../src/core/monitor');
const { plainSecretBox } = await import('../src/core/config');

let dir = '';
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function make() {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwm-pc-'));
  const m = new Monitor(dir, plainSecretBox, 'test');
  const c = m.cfg.config;
  c.devices = [
    { id: 'house', name: 'House sender', ip: '10.255.0.1', site: 'House', role: 'backbone-ap', enabled: true },
    { id: 'ap1', name: 'AP 1', ip: '10.255.0.2', site: 'Lookout', role: 'ap', enabled: true },
  ];
  c.chain = ['house'];
  c.probes = [
    { id: 'internet', name: 'Internet', host: '8.8.8.8' },
    { id: 'udr3', name: 'House router (UDR3)', host: '10.255.0.254' },
  ];
  c.thresholds.sustainPolls = 2;
  return m;
}
const pingKinds = /:(offline|loss|latency|api)$/;

describe('Monitor with a bad PC connection', () => {
  it('raises one PC alert, no radio ping alerts, and marks the readings', async () => {
    const m = make();
    net.slow = true;
    for (let i = 0; i < 4; i++) await m.pollNow();
    m.stop();
    const keys = [...m.alerts.active.keys()];
    expect(keys).toContain('pc:connection');
    expect(keys.filter((k) => pingKinds.test(k))).toEqual([]);
    expect(m.history.range('ap1', 1).every((s) => s.pcFault)).toBe(true);
  });
  it('alerts on the radios as normal when only they are slow', async () => {
    const m = make();
    net.slow = false;
    await m.pollNow();
    expect(m.alerts.active.has('pc:connection')).toBe(false);
    m.stop();
  });
});
