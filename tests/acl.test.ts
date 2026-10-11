import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { ACL_MAX, blockedMacs, parseAcl, planBlock, planUnblock } from '../src/core/acl';
import { enoughBack } from '../src/core/blocker';
import { CFG } from '../src/core/airos-ssh';

const BASE = 'aaa.1.status=enabled\nradio.1.freq=2437\nwireless.1.ssid=Lookout & Monks Meadow\n';
const FIRE = '14:91:38:86:C9:D1';

/** Run plan commands for real against a copy of a config, the way the radio's shell would. */
function runOn(cfg: string, cmds: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwm-acl-'));
  const file = path.join(dir, 'system.cfg');
  fs.writeFileSync(file, cfg);
  // forward slashes so Git Bash's sh on Windows (the release build) reads the path too
  execFileSync('sh', ['-c', ['set -e', ...cmds].join('\n').replaceAll(CFG, file.replace(/\\/g, '/'))]);
  const out = fs.readFileSync(file, 'utf8');
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}
const sorted = (cfg: string) => cfg.split('\n').filter(Boolean).sort().join('\n');

describe('parseAcl', () => {
  it('reads status, policy and entries', () => {
    const a = parseAcl(BASE + 'wireless.1.mac_acl.status=enabled\nwireless.1.mac_acl.policy=deny\nwireless.1.mac_acl.1.mac=70:54:b4:4c:d3:e9\nwireless.1.mac_acl.1.status=enabled\nwireless.1.mac_acl.3.mac=AA:AA:AA:AA:AA:AA\nwireless.1.mac_acl.3.status=disabled\n');
    expect(a.on).toBe(true);
    expect(a.policy).toBe('deny');
    expect(a.entries).toEqual([
      { idx: 1, mac: '70:54:B4:4C:D3:E9', enabled: true },
      { idx: 3, mac: 'AA:AA:AA:AA:AA:AA', enabled: false },
    ]);
    expect(blockedMacs(a)).toEqual(['70:54:B4:4C:D3:E9']);
  });
  it('treats a missing ACL as off and empty', () => {
    expect(parseAcl(BASE)).toMatchObject({ on: null, policy: null, entries: [] });
  });
});

describe('planBlock', () => {
  it('switches a deny list on and adds the MAC when there was no ACL, and undoes it exactly', () => {
    const p = planBlock(parseAcl(BASE), FIRE.toLowerCase());
    expect(p.kind).toBe('apply');
    if (p.kind !== 'apply') return;
    const after = runOn(BASE, [...p.edits, ...p.check]);
    const a = parseAcl(after);
    expect(blockedMacs(a)).toEqual([FIRE]);
    expect(after).toContain('radio.1.freq=2437');
    expect(sorted(runOn(after, p.undo))).toBe(sorted(BASE));
  });
  it('adds to an existing deny list without touching other entries', () => {
    const cfg = BASE + 'wireless.1.mac_acl.status=enabled\nwireless.1.mac_acl.policy=deny\nwireless.1.mac_acl.2.mac=70:54:B4:4C:D3:E9\nwireless.1.mac_acl.2.status=enabled\n';
    const p = planBlock(parseAcl(cfg), FIRE);
    if (p.kind !== 'apply') throw new Error(p.reason);
    expect(p.describe).toBe('entry 3');
    const after = runOn(cfg, [...p.edits, ...p.check]);
    expect(blockedMacs(parseAcl(after)).sort()).toEqual(['14:91:38:86:C9:D1', '70:54:B4:4C:D3:E9']);
    expect(sorted(runOn(after, p.undo))).toBe(sorted(cfg));
  });
  it('re-enables a switched-off entry for the same MAC', () => {
    const cfg = BASE + `wireless.1.mac_acl.status=enabled\nwireless.1.mac_acl.policy=deny\nwireless.1.mac_acl.1.mac=${FIRE}\nwireless.1.mac_acl.1.status=disabled\n`;
    const p = planBlock(parseAcl(cfg), FIRE);
    if (p.kind !== 'apply') throw new Error(p.reason);
    const after = runOn(cfg, [...p.edits, ...p.check]);
    expect(blockedMacs(parseAcl(after))).toEqual([FIRE]);
    expect(sorted(runOn(after, p.undo))).toBe(sorted(cfg));
  });
  it('refuses an allow list, where adding a MAC would lock everyone else out', () => {
    const cfg = BASE + 'wireless.1.mac_acl.status=enabled\nwireless.1.mac_acl.policy=allow\nwireless.1.mac_acl.1.mac=60:02:B4:B8:32:A9\nwireless.1.mac_acl.1.status=enabled\n';
    const p = planBlock(parseAcl(cfg), FIRE);
    expect(p.kind).toBe('refuse');
    expect(p.kind === 'refuse' && p.reason).toContain('allow list');
  });
  it('refuses to switch an ACL on when old entries would come back with it', () => {
    const cfg = BASE + 'wireless.1.mac_acl.status=disabled\nwireless.1.mac_acl.policy=allow\nwireless.1.mac_acl.1.mac=60:02:B4:B8:32:A9\nwireless.1.mac_acl.1.status=enabled\n';
    expect(planBlock(parseAcl(cfg), FIRE).kind).toBe('refuse');
  });
  it('does nothing when already blocked, and refuses a full list or a bad MAC', () => {
    const cfg = BASE + `wireless.1.mac_acl.status=enabled\nwireless.1.mac_acl.policy=deny\nwireless.1.mac_acl.1.mac=${FIRE}\nwireless.1.mac_acl.1.status=enabled\n`;
    expect(planBlock(parseAcl(cfg), FIRE).kind).toBe('nothing');
    const full =
      BASE +
      'wireless.1.mac_acl.status=enabled\nwireless.1.mac_acl.policy=deny\n' +
      Array.from({ length: ACL_MAX }, (_, i) => `wireless.1.mac_acl.${i + 1}.mac=00:00:00:00:00:${(i + 16).toString(16)}\nwireless.1.mac_acl.${i + 1}.status=enabled\n`).join('');
    expect(planBlock(parseAcl(full), FIRE).kind).toBe('refuse');
    expect(planBlock(parseAcl(BASE), "14:91:38'; rm -rf /").kind).toBe('refuse');
  });
  it('fails the check, so nothing is applied, when the file does not take the edit', () => {
    const p = planBlock(parseAcl(BASE), FIRE);
    if (p.kind !== 'apply') throw new Error('expected apply');
    expect(() => runOn(BASE, p.check)).toThrow();
  });
});

describe('planUnblock', () => {
  it('removes the entry and leaves the rest, and the undo puts it back', () => {
    const cfg =
      BASE +
      `wireless.1.mac_acl.status=enabled\nwireless.1.mac_acl.policy=deny\nwireless.1.mac_acl.1.mac=70:54:B4:4C:D3:E9\nwireless.1.mac_acl.1.status=enabled\nwireless.1.mac_acl.2.mac=${FIRE}\nwireless.1.mac_acl.2.status=enabled\n`;
    const p = planUnblock(parseAcl(cfg), FIRE);
    if (p.kind !== 'apply') throw new Error('expected apply');
    const after = runOn(cfg, [...p.edits, ...p.check]);
    expect(blockedMacs(parseAcl(after))).toEqual(['70:54:B4:4C:D3:E9']);
    expect(sorted(runOn(after, p.undo))).toBe(sorted(cfg));
  });
  it('does nothing where it is not blocked and refuses allow lists', () => {
    expect(planUnblock(parseAcl(BASE), FIRE).kind).toBe('nothing');
    expect(planUnblock(parseAcl(BASE + 'wireless.1.mac_acl.status=enabled\nwireless.1.mac_acl.policy=allow\n'), FIRE).kind).toBe('refuse');
  });
});

describe('enoughBack', () => {
  it('expects most of the other devices to reconnect', () => {
    expect(enoughBack(5, 2)).toBe(true);
    expect(enoughBack(5, 1)).toBe(false);
    expect(enoughBack(1, 0)).toBe(true);
    expect(enoughBack(null, 0)).toBe(true);
  });
});

import { BlockManager, type BlockHost } from '../src/core/blocker';
import type { Station } from '../src/core/types';

describe('BlockManager', () => {
  const st = (mac: string): Station => ({ mac, name: '', ip: '', signal: -70, noise: -90, ccq: 80, txRate: 6, rxRate: 6, latency: null, uptime: 1, distanceM: null });
  function make(stations: () => Station[] | null) {
    const cmds: string[] = [];
    const fakeSsh = {
      run: async (c: string) => {
        cmds.push(c);
        if (c.includes("'@END'")) return 'wireless.1.mac_acl.status=enabled\nwireless.1.mac_acl.policy=deny\n@SOFTRESTART\n@END\n';
        if (c.includes('pwm-selftest 2>/dev/null')) return 'ok\n';
        if (c.includes('@APPLIED')) return '@APPLIED\n';
        if (c.includes('@KEPT')) return '@KEPT\n';
        if (c.includes('@RESTORED')) return '@RESTORED\n';
        return '';
      },
      confirm: async () => undefined,
    };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pwm-blk-'));
    const host: BlockHost = {
      aps: () => [{ id: 'ap1', name: 'AP1', ip: '10.0.0.1' }],
      ssh: () => fakeSsh as never,
      stations: async () => stations(),
      liveCount: () => 4,
      label: () => 'Fire-TV',
      changed: () => undefined,
      log: () => undefined,
    };
    const m = new BlockManager(dir, host, { settleMs: 1, verifyEveryMs: 1, verifyTries: 2, selftestWaitMs: 1 });
    return { m, cmds };
  }
  const finished = async (m: BlockManager) => {
    for (let i = 0; i < 200 && !m.state.job?.endedAt; i++) await new Promise((r) => setTimeout(r, 5));
    return m.state.job!.steps[0];
  };
  it('keeps the block when the device is gone and the others came back', async () => {
    const { m } = make(() => [st('A'), st('B'), st('C')]);
    m.start('block', FIRE);
    expect((await finished(m)).state).toBe('done');
  });
  it('undoes it when the device is still connected', async () => {
    const { m, cmds } = make(() => [st(FIRE), st('B'), st('C')]);
    m.start('block', FIRE);
    const s = await finished(m);
    expect(s.state).toBe('undone');
    expect(s.message).toContain('block did not take');
    expect(cmds.some((c) => c.includes('@RESTORED'))).toBe(true);
  });
  it('undoes it when the other devices did not come back, or the AP stopped answering', async () => {
    const a = make(() => []);
    a.m.start('block', FIRE);
    expect((await finished(a.m)).message).toContain('only 0 of its other 3 devices came back');
    const b = make(() => null);
    b.m.start('block', FIRE);
    expect((await finished(b.m)).message).toContain('stopped answering');
  });
  it('runs one job at a time', () => {
    const { m } = make(() => [st('B'), st('C')]);
    m.start('block', FIRE);
    expect(() => m.start('block', FIRE)).toThrow('One at a time');
  });
});
