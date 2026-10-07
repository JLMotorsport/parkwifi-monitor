import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeManager, evaluate, stats, type TrialHost } from '../src/core/changes';
import type { RadioChange, Sample, Suggestion, TrialStats } from '../src/core/types';

const base: TrialStats = { samples: 10, reachablePct: 100, pingAvg: 10, lossAvg: 0, clients: 5, noise: -85, ccq: 70, txPower: 20, frequency: 2432 };

describe('evaluate', () => {
  it('passes a power change that took effect and broke nothing', () => {
    const c = evaluate({ txPower: 17 }, base, { ...base, txPower: 17, clients: 4 });
    expect(c.every((x) => x.ok)).toBe(true);
  });
  it('fails when the setting did not take', () => {
    expect(evaluate({ txPower: 17 }, base, { ...base, txPower: 20 }).find((x) => !x.ok)?.name).toBe('New power in use');
  });
  it('fails when devices did not come back', () => {
    expect(evaluate({ frequency: 2437 }, base, { ...base, frequency: 2437, clients: 2 }).find((x) => !x.ok)?.name).toBe('Devices came back');
  });
  it('fails a channel that is noisier', () => {
    expect(evaluate({ frequency: 2437 }, base, { ...base, frequency: 2437, noise: -80 }).find((x) => !x.ok)?.name).toBe('Channel no noisier');
  });
  it('fails a channel where the link quality dropped, and ignores CCQ for power changes', () => {
    expect(evaluate({ frequency: 2437 }, base, { ...base, frequency: 2437, ccq: 58 }).find((x) => !x.ok)?.name).toBe('Link quality no worse');
    expect(evaluate({ frequency: 2437 }, base, { ...base, frequency: 2437, ccq: 90 }).find((x) => x.name === 'Link quality no worse')?.detail).toContain('better');
    expect(evaluate({ txPower: 17 }, base, { ...base, txPower: 17, ccq: 40 }).every((x) => x.ok)).toBe(true);
  });
  it('fails when ping or loss got worse, or the radio dropped out', () => {
    expect(evaluate({ txPower: 17 }, base, { ...base, txPower: 17, pingAvg: 40 }).some((x) => !x.ok)).toBe(true);
    expect(evaluate({ txPower: 17 }, base, { ...base, txPower: 17, lossAvg: 10 }).some((x) => !x.ok)).toBe(true);
    expect(evaluate({ txPower: 17 }, base, { ...base, txPower: 17, reachablePct: 50 }).some((x) => !x.ok)).toBe(true);
  });
});

function sample(t: number, txPower: number, frequency = 2432, clients = 5, up = true): Sample {
  return {
    t,
    id: 'ap1',
    ping: { sent: 5, received: up ? 5 : 0, lossPct: up ? 0 : 100, avg: up ? 10 : null, min: null, max: null },
    radio: up
      ? ({ txPower, frequency, noise: -85 } as Sample['radio'])
      : undefined,
    stations: up ? { count: clients, weak: 0, avgSignal: -70, worstSignal: -80, noIp: 0 } : undefined,
  };
}

describe('stats', () => {
  it('summarises readings', () => {
    const s = stats([sample(1, 20), sample(2, 17), sample(3, 17, 2432, 5, false)]);
    expect(s.reachablePct).toBe(67);
    expect(s.txPower).toBe(17);
    expect(s.clients).toBe(5);
  });
  it('averages CCQ only over readings with devices on', () => {
    const a = sample(1, 17);
    a.radio = { ...a.radio!, ccq: 80 };
    const b = sample(2, 17, 2432, 0);
    b.radio = { ...b.radio!, ccq: 0 };
    expect(stats([a, b]).ccq).toBe(80);
  });
});

describe('ChangeManager', () => {
  let dir: string;
  let radio: { txPower: number; pending: string | null; up: boolean; calls: string[] };
  let host: TrialHost;
  const sug: Suggestion = { id: 'power:ap1', kind: 'power', deviceId: 'ap1', deviceName: 'AP1', severity: 'warning', title: '', why: '', fix: '', change: { txPower: 17 }, changeLabel: 'Set power 17 dBm' };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwm-'));
    radio = { txPower: 20, pending: null, up: true, calls: [] };
    const now = Date.now();
    host = {
      suggestions: () => [sug],
      device: () => ({ ip: '10.0.0.1', name: 'AP1', isAp: true }),
      history: () => [1, 2, 3, 4].map((i) => sample(now - i * 60000, 20)),
      sample: async () => sample(Date.now(), radio.txPower, 2432, 5, radio.up),
      ssh: () => ({
        preflight: async () => ({ ok: true, problems: [], values: { 'radio.1.txpower': String(radio.txPower) }, pendingFromEarlier: false }),
        applyTrial: async (c: RadioChange, _s: number, tok: string) => {
          radio.calls.push('apply');
          radio.txPower = c.txPower!;
          radio.pending = tok;
        },
        confirm: async (tok: string) => {
          radio.calls.push('confirm');
          if (radio.pending !== tok) throw new Error('gone');
          radio.pending = null;
        },
        restore: async (b: RadioChange) => {
          radio.calls.push('restore');
          radio.txPower = b.txPower!;
          radio.pending = null;
        },
      }),
      trialMinutes: () => 3,
      thresholds: () => ({ latencyMs: 40, lossPct: 10, backboneCcq: 90, backboneCapacity: 80, weakSignal: -75, apNoise: -80, sustainPolls: 3 }),
      changed: () => undefined,
      log: () => undefined,
    };
  });
  afterEach(() => vi.useRealTimers());

  it('keeps a change that passes every check', async () => {
    const m = new ChangeManager(dir, host);
    await m.start('power:ap1');
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(m.trial?.status).toBe('kept');
    expect(radio.calls).toEqual(['apply', 'confirm']);
    expect(radio.txPower).toBe(17);
    expect(fs.readFileSync(path.join(dir, 'changes.jsonl'), 'utf8')).toContain('"kept"');
  });

  it('undoes early when the radio stops answering', async () => {
    const m = new ChangeManager(dir, host);
    await m.start('power:ap1');
    radio.up = false;
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(m.trial?.status).toBe('reverted');
    expect(radio.calls).toContain('restore');
    expect(radio.txPower).toBe(20);
  });

  it('undoes when the setting never took effect', async () => {
    const h = host.ssh;
    host.ssh = (ip) => ({ ...h(ip), applyTrial: async (_c, _s, tok) => void (radio.pending = tok) });
    const m = new ChangeManager(dir, host);
    await m.start('power:ap1');
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(m.trial?.status).toBe('reverted');
    expect(m.trial?.message).toContain('new power in use');
  });

  it('changes nothing when the preflight check fails', async () => {
    const h = host.ssh;
    host.ssh = (ip) => ({ ...h(ip), preflight: async () => ({ ok: false, problems: ['radio.1.txpower is not in /tmp/system.cfg'], values: {}, pendingFromEarlier: false }) });
    const m = new ChangeManager(dir, host);
    await m.start('power:ap1');
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.trial?.status).toBe('failed');
    expect(radio.calls).toEqual([]);
  });

  it('refuses anything that is not an access point, and runs one test at a time', async () => {
    host.device = () => ({ ip: '10.0.0.1', name: 'S', isAp: false });
    await expect(new ChangeManager(dir, host).start('power:ap1')).rejects.toThrow(/access points/);
    host.device = () => ({ ip: '10.0.0.1', name: 'AP1', isAp: true });
    const m = new ChangeManager(dir, host);
    await m.start('power:ap1');
    await expect(m.start('power:ap1')).rejects.toThrow(/One at a time/);
  });

  it('puts the old settings back after an app restart mid-test', async () => {
    const m = new ChangeManager(dir, host);
    await m.start('power:ap1');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(m.trial?.status).toBe('testing');
    m.shutdown();
    const again = new ChangeManager(dir, host);
    await again.recover();
    expect(again.trial?.status).toBe('reverted');
    expect(radio.txPower).toBe(20);
  });
});
