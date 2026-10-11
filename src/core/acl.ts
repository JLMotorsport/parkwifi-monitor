// Blocking a device on an access point through airOS's MAC ACL, over SSH. The planning is pure and
// refuses anything that could lock other devices out: an AP set to an allow list (where adding a
// MAC would let only that device in), or old entries that are switched off and would come back.
import { CFG } from './airos-ssh';

export const MAC_RE = /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/;
/** airOS 6 holds at most 32 ACL entries. */
export const ACL_MAX = 32;
const P = 'wireless.1.mac_acl';

export interface Acl {
  /** true when the ACL is switched on */
  on: boolean | null;
  policy: string | null;
  entries: { idx: number; mac: string; enabled: boolean }[];
  /** the key/value lines as read, for putting back exactly */
  raw: Record<string, string>;
}

export function parseAcl(text: string): Acl {
  const raw: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^(wireless\.1\.mac_acl\.[a-z0-9.]+)=(.*)$/i);
    if (m) raw[m[1]] = m[2].trim();
  }
  const idx = new Set<number>();
  for (const k of Object.keys(raw)) {
    const m = k.match(/^wireless\.1\.mac_acl\.(\d+)\./);
    if (m) idx.add(Number(m[1]));
  }
  const entries = [...idx]
    .sort((a, b) => a - b)
    .map((i) => ({ idx: i, mac: (raw[`${P}.${i}.mac`] ?? '').toUpperCase(), enabled: raw[`${P}.${i}.status`] === 'enabled' }))
    .filter((e) => e.mac);
  const st = raw[`${P}.status`];
  return { on: st === undefined ? null : st === 'enabled', policy: raw[`${P}.policy`] ?? null, entries, raw };
}

/** MACs this AP actually blocks right now. */
export function blockedMacs(acl: Acl): string[] {
  return acl.on && acl.policy === 'deny' ? acl.entries.filter((e) => e.enabled).map((e) => e.mac) : [];
}

const setKey = (key: string, val: string) => [`sed -i '/^${key.replace(/\./g, '\\.')}=/d' ${CFG}`, `echo '${key}=${val}' >> ${CFG}`];
const delKey = (key: string) => [`sed -i '/^${key.replace(/\./g, '\\.')}=/d' ${CFG}`];
const delEntry = (i: number) => [`sed -i '/^wireless\\.1\\.mac_acl\\.${i}\\./d' ${CFG}`];
/** Put a key back to what it was, or remove it if it wasn't there. */
const restoreKey = (acl: Acl, key: string) => (key in acl.raw ? setKey(key, acl.raw[key]) : delKey(key));

export type Plan =
  | { kind: 'refuse'; reason: string }
  | { kind: 'nothing'; reason: string }
  | { kind: 'apply'; edits: string[]; check: string[]; undo: string[]; describe: string };

export function planBlock(acl: Acl, macIn: string): Plan {
  const mac = macIn.toUpperCase();
  if (!MAC_RE.test(mac)) return { kind: 'refuse', reason: `${macIn} is not a MAC address.` };
  if (acl.on && acl.policy !== 'deny') {
    return { kind: 'refuse', reason: `This AP's MAC ACL is an allow list (policy "${acl.policy ?? '?'}"): adding a MAC there lets it in rather than keeping it out. Change it by hand.` };
  }
  if (!acl.on && acl.entries.length) {
    return { kind: 'refuse', reason: `This AP has ${acl.entries.length} old ACL entr${acl.entries.length === 1 ? 'y' : 'ies'} with the ACL switched off; switching it on would bring ${acl.entries.length === 1 ? 'it' : 'them'} back too. Tidy the list by hand first.` };
  }
  const existing = acl.entries.find((e) => e.mac === mac);
  if (existing?.enabled && acl.on) return { kind: 'nothing', reason: 'Already blocked here.' };
  const edits: string[] = [];
  const undo: string[] = [];
  const check: string[] = [];
  let i: number;
  if (existing) {
    i = existing.idx;
    edits.push(...setKey(`${P}.${i}.status`, 'enabled'));
    undo.push(...restoreKey(acl, `${P}.${i}.status`));
  } else {
    if (acl.entries.length >= ACL_MAX) return { kind: 'refuse', reason: `This AP's ACL is full (${ACL_MAX} entries). Remove old ones by hand first.` };
    i = Math.max(0, ...acl.entries.map((e) => e.idx)) + 1;
    edits.push(...setKey(`${P}.${i}.mac`, mac), ...setKey(`${P}.${i}.status`, 'enabled'));
    undo.push(...delEntry(i));
  }
  check.push(`grep -qi '^wireless\\.1\\.mac_acl\\.${i}\\.mac=${mac}$' ${CFG}`, `grep -q '^wireless\\.1\\.mac_acl\\.${i}\\.status=enabled$' ${CFG}`);
  if (!acl.on) {
    edits.push(...setKey(`${P}.status`, 'enabled'), ...setKey(`${P}.policy`, 'deny'));
    undo.push(...restoreKey(acl, `${P}.status`), ...restoreKey(acl, `${P}.policy`));
  }
  check.push(`grep -q '^wireless\\.1\\.mac_acl\\.status=enabled$' ${CFG}`, `grep -q '^wireless\\.1\\.mac_acl\\.policy=deny$' ${CFG}`);
  return { kind: 'apply', edits, check, undo, describe: `entry ${i}${acl.on ? '' : ', and switches the deny list on'}` };
}

export function planUnblock(acl: Acl, macIn: string): Plan {
  const mac = macIn.toUpperCase();
  if (!MAC_RE.test(mac)) return { kind: 'refuse', reason: `${macIn} is not a MAC address.` };
  if (acl.policy && acl.policy !== 'deny') return { kind: 'refuse', reason: `This AP's ACL is an allow list; removing a MAC there would lock that device out. Change it by hand.` };
  const hits = acl.entries.filter((e) => e.mac === mac);
  if (!hits.length) return { kind: 'nothing', reason: 'Not blocked here.' };
  const edits = hits.flatMap((e) => delEntry(e.idx));
  const undo = hits.flatMap((e) => [...setKey(`${P}.${e.idx}.mac`, e.mac), ...restoreKey(acl, `${P}.${e.idx}.status`)]);
  // (not "! grep": a negated command never stops a set -e script)
  const check = hits.map((e) => `if grep -q '^wireless\\.1\\.mac_acl\\.${e.idx}\\.' ${CFG}; then exit 1; fi`);
  return { kind: 'apply', edits, check, undo, describe: `removes entr${hits.length === 1 ? 'y' : 'ies'} ${hits.map((e) => e.idx).join(', ')}` };
}
