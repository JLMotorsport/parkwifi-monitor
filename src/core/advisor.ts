// Turns the latest readings into plain-English suggestions. Pure: no I/O, fully unit tested.
// Only access-point power and channel changes carry a `change` the app may apply itself;
// everything on the backbone stays advice, because a bad change there cuts off the app too.
import { FLOOD_SERIOUS_PPS, FLOOD_WARN_PPS } from './alerts';
import type { AlertItem, DeviceState, GatewayStats, Sample, Severity, Suggestion, Thresholds } from './types';

export interface AdvisorInput {
  devices: DeviceState[];
  chain: string[];
  events: AlertItem[];
  thresholds: Thresholds;
  now: number;
  /** per AP: how its devices' link quality (CCQ) looked on each frequency it has used recently */
  channelHistory?: Record<string, ChannelQuality>;
  gateway?: {
    id: string;
    name: string;
    stats?: GatewayStats;
    /** 95th percentile of each minute's busiest 15 s, over the last 3 days (Mbps) */
    peakDown95: number | null;
    peakUp95: number | null;
    samples: number;
    /** what the backbone can really carry (Mbps), from Settings */
    capacity: number;
  };
}

export type ChannelQuality = Record<number, { ccq: number; samples: number }>;
/** Readings on a channel needed before its history counts (about half an hour at one a minute). */
export const MIN_CHANNEL_SAMPLES = 30;

/**
 * Median CCQ per frequency from an AP's history. Only readings with devices on count: an empty
 * AP reports CCQ 0, which says nothing about the channel.
 */
export function channelQuality(rows: Sample[]): ChannelQuality {
  const by = new Map<number, number[]>();
  for (const r of rows) {
    const f = r.radio?.frequency;
    const q = r.radio?.ccq;
    if (f == null || q == null || q <= 0 || (r.stations?.count ?? 0) === 0) continue;
    if (!by.has(f)) by.set(f, []);
    by.get(f)!.push(q);
  }
  const out: ChannelQuality = {};
  for (const [f, xs] of by) {
    xs.sort((a, b) => a - b);
    out[f] = { ccq: Math.round(xs[Math.floor(xs.length / 2)]), samples: xs.length };
  }
  return out;
}

/** Minutes of gateway history needed before calling the backbone full (about 6 hours). */
export const MIN_LOAD_SAMPLES = 360;

/** Non-overlapping 2.4 GHz channels. */
export const PLAN = [1, 6, 11] as const;
export const freqOf = (ch: number) => 2407 + 5 * ch;
/** Above this, a NanoStation M2 out-shouts the phones it serves. */
export const MAX_AP_POWER = 17;

const RANK: Record<Suggestion['severity'], number> = { critical: 0, serious: 1, warning: 2, info: 3 };

export function isAccessPoint(d: DeviceState, chain: string[]) {
  return d.cfg.enabled && !chain.includes(d.cfg.id) && d.role === 'ap';
}

/**
 * Give each 2.4 GHz access point at a site a channel from 1/6/11, busiest AP first, spreading them
 * as evenly as possible and keeping an AP where it is when it already sits on a free plan channel.
 */
export function channelPlan(aps: DeviceState[]): Map<string, number> {
  const out = new Map<string, number>();
  const bySite = new Map<string, DeviceState[]>();
  for (const d of aps) {
    const r = d.latest?.radio;
    if (!r || r.channel == null || r.frequency == null || r.frequency > 3000) continue;
    const k = d.cfg.site || '?';
    if (!bySite.has(k)) bySite.set(k, []);
    bySite.get(k)!.push(d);
  }
  for (const list of bySite.values()) {
    list.sort((a, b) => (b.latest?.stations?.count ?? 0) - (a.latest?.stations?.count ?? 0) || a.cfg.name.localeCompare(b.cfg.name));
    const used = new Map<number, number>(PLAN.map((c) => [c, 0]));
    for (const d of list) {
      const cur = d.latest!.radio!.channel!;
      const min = Math.min(...used.values());
      let ch: number;
      if ((PLAN as readonly number[]).includes(cur) && used.get(cur) === min) ch = cur;
      else ch = [...PLAN].sort((a, b) => used.get(a)! - used.get(b)! || Math.abs(a - cur) - Math.abs(b - cur))[0];
      used.set(ch, used.get(ch)! + 1);
      out.set(d.cfg.id, ch);
    }
  }
  return out;
}

export function advise(inp: AdvisorInput): Suggestion[] {
  const { devices, chain, events, thresholds: th, now } = inp;
  const out: Suggestion[] = [];
  const add = (s: Omit<Suggestion, 'id' | 'deviceName'> & { deviceName?: string }) => {
    const d = devices.find((x) => x.cfg.id === s.deviceId);
    out.push({ ...s, id: `${s.kind}:${s.deviceId}`, deviceName: s.deviceName ?? d?.cfg.name ?? s.deviceId });
  };

  const aps = devices.filter((d) => isAccessPoint(d, chain));
  const plan = channelPlan(aps);

  for (const d of aps) {
    const r = d.latest?.radio;
    const st = d.latest?.stations;
    const name = d.cfg.name;

    // ---- channel ----
    const target = plan.get(d.cfg.id);
    // Don't send an AP back to a channel where its devices measurably did worse.
    const hist = inp.channelHistory?.[d.cfg.id];
    const was = target != null ? hist?.[freqOf(target)] : undefined;
    const nowQ = r?.frequency != null ? hist?.[r.frequency] : undefined;
    const nowCcq = nowQ && nowQ.samples >= MIN_CHANNEL_SAMPLES ? nowQ.ccq : (st?.count ?? 0) > 0 && (r?.ccq ?? 0) > 0 ? r!.ccq : null;
    const worseThere = !!was && was.samples >= MIN_CHANNEL_SAMPLES && nowCcq != null && was.ccq < nowCcq - 5;
    if (r && r.channel != null && target != null && target !== r.channel && worseThere) {
      add({
        kind: 'channel',
        deviceId: d.cfg.id,
        severity: 'info',
        title: `Leave ${name} on channel ${r.channel} for now`,
        why: `The channel plan would put it on ${target}, but when it was on ${target} its devices' link quality was about ${was!.ccq}%, against ${nowCcq}% on ${r.channel}. Something near it uses ${target}: a neighbour's WiFi, an extender, or another of your APs.`,
        fix: `Find what is on channel ${target} near ${name} (airOS Site Survey) and remove or move it, then try ${target} again with a test.`,
      });
    } else if (r && r.channel != null && target != null && target !== r.channel) {
      const peers = aps.filter((x) => x !== d && x.cfg.site === d.cfg.site && x.latest?.radio?.channel != null);
      const overlap = peers.filter((x) => Math.abs(x.latest!.radio!.channel! - r.channel!) < 5);
      const noisy = r.noise != null && r.noise > th.apNoise;
      const parts: string[] = [];
      if (!(PLAN as readonly number[]).includes(r.channel)) parts.push(`Channel ${r.channel} is not one of 1, 6 or 11, so it overlaps two of them at once.`);
      if (overlap.length) parts.push(`At ${d.cfg.site} it overlaps ${overlap.map((x) => `${x.cfg.name} (ch ${x.latest!.radio!.channel})`).join(', ')}, and overlapping APs talk over each other.`);
      if (noisy) parts.push(`Its noise floor is ${r.noise} dBm, above your ${th.apNoise} dBm limit.`);
      add({
        kind: 'channel',
        deviceId: d.cfg.id,
        severity: overlap.length || noisy ? 'warning' : 'info',
        title: `Move ${name} to channel ${target}`,
        why: parts.join(' ') || `Channel ${target} spreads the APs at ${d.cfg.site} across 1, 6 and 11.`,
        fix: `Set ${name} to channel ${target} (${freqOf(target)} MHz). Phones follow automatically; each one drops for a few seconds.`,
        change: { frequency: freqOf(target) },
        changeLabel: `Set channel ${target}`,
      });
    } else if (r && r.noise != null && r.noise > th.apNoise) {
      add({
        kind: 'noise',
        deviceId: d.cfg.id,
        severity: 'warning',
        title: `${name} is on a noisy channel`,
        why: `Noise floor ${r.noise} dBm on channel ${r.channel} (limit ${th.apNoise} dBm). Phones further away can't be heard over it.`,
        fix: `It is already on its best plan channel, so the noise is from outside (a neighbour's WiFi or another of your APs at full power). Check what is nearby with airOS's Site Survey tool, and lower the power of your own APs that can hear it.`,
      });
    }

    // ---- power ----
    if (r && r.txPower != null && r.txPower > MAX_AP_POWER) {
      add({
        kind: 'power',
        deviceId: d.cfg.id,
        severity: (st?.weak ?? 0) > 0 ? 'warning' : 'info',
        title: `Turn ${name} down to ${MAX_AP_POWER} dBm`,
        why: `It transmits at ${r.txPower} dBm. Phones answer at roughly 12 to 15 dBm, so above ${MAX_AP_POWER} the AP reaches devices that can't reply: they connect, show full bars and then fail to upload. It also drowns out your other APs.`,
        fix: `Set transmit power to ${MAX_AP_POWER} dBm. Devices at the very edge may move to a closer AP or drop, which is better than a connection that never uploads.`,
        change: { txPower: MAX_AP_POWER },
        changeLabel: `Set power ${MAX_AP_POWER} dBm`,
      });
    }

    // ---- clients without an address ----
    if (st && st.noIp > 0) {
      add({
        kind: 'no-ip',
        deviceId: d.cfg.id,
        severity: 'info',
        title: `${st.noIp} device${st.noIp === 1 ? '' : 's'} on ${name} with no IP address`,
        why: `They are connected to the radio but never got an address, so they have no internet at all. Usually the signal is too weak for the address request to get through, or DHCP on UDR3 is out of addresses.`,
        fix: `Check the weakest devices on this AP first. If several APs show this at once, check the DHCP range and lease count for the Lookout & Monks network on UDR3.`,
      });
    }

    // ---- weak clients ----
    if (st && st.count >= 3 && st.weak / st.count >= 0.5) {
      add({
        kind: 'weak-clients',
        deviceId: d.cfg.id,
        severity: 'info',
        title: `${st.weak} of ${st.count} devices on ${name} have a weak signal`,
        why: `They are at or below ${th.weakSignal} dBm. At that level the phone's reply is what fails, so uploads stall even when the download looks fine.`,
        fix: `Turning this AP up will not help: the weak side is the phone. The fixes are physical: an AP closer to those caravans, or a small outdoor client radio on the caravans that struggle most.`,
      });
    }
  }

  // ---- restarts (any radio) ----
  const dayAgo = now - 86400000;
  for (const d of devices.filter((x) => x.cfg.enabled)) {
    const n = events.filter((e) => e.event && e.deviceId === d.cfg.id && e.key.split(':')[1] === 'reboot' && e.startedAt >= dayAgo).length;
    if (n >= 2) {
      add({
        kind: 'restarts',
        deviceId: d.cfg.id,
        severity: 'serious',
        title: `${d.cfg.name} restarted ${n} times in 24 hours`,
        why: `Radios don't restart on their own when healthy. Repeated restarts are nearly always power: a failing PoE injector, a water-damaged or long cable, or the radio overheating.`,
        fix: `Swap the PoE injector first, then check the cable and its connectors for water. If it still restarts, the radio itself is failing.`,
      });
    }
    if (d.latest?.error && d.latest.ping.received > 0) {
      add({
        kind: 'login',
        deviceId: d.cfg.id,
        severity: 'info',
        title: `Can't read ${d.cfg.name}`,
        why: `It answers ping but the app can't log in: ${d.latest.error}`,
        fix: `Use Test login on this radio. If the password differs from the others, it needs changing on the radio; if the web page is off, turn it back on.`,
      });
    }
  }

  // ---- backbone ----
  const byId = new Map(devices.map((d) => [d.cfg.id, d]));
  const ch = chain.map((id) => byId.get(id)).filter((d): d is DeviceState => !!d && d.cfg.enabled);
  for (let i = 0; i < ch.length; i++) {
    const d = ch[i];
    const r = d.latest?.radio;
    if (d.role === 'backbone-sta' && r) {
      const bad: string[] = [];
      if (r.airmaxCapacity != null && r.airmaxCapacity < th.backboneCapacity) bad.push(`airMAX capacity ${r.airmaxCapacity}%`);
      if (r.ccq != null && r.ccq < th.backboneCcq) bad.push(`CCQ ${r.ccq}%`);
      if ((r.txRate ?? 999) < 100 || (r.rxRate ?? 999) < 100) bad.push(`rates ${r.txRate}/${r.rxRate} Mbps`);
      if (bad.length) {
        add({
          kind: 'backbone-link',
          deviceId: d.cfg.id,
          severity: 'warning',
          title: `Backbone link into ${d.cfg.name} is below par`,
          why: `${bad.join(', ')} with signal ${r.signal ?? '?'} dBm. With a good signal, low capacity means interference or something partly in the way (trees in leaf, a new building).`,
          fix: `Check the alignment and the line of sight on both ends, then run a Site Survey on the sender and move the link to the quietest 5 GHz channel. The app won't change backbone radios itself: a bad change there would cut off everything behind it.`,
        });
      }
    }
    const prev = ch[i - 1];
    if (prev && d.cfg.site !== prev.cfg.site) {
      const a = prev.latest?.ping.avg;
      const b = d.latest?.ping.avg;
      const cap = d.latest?.radio?.airmaxCapacity;
      if (a != null && b != null && b - a >= 20 && (cap == null || cap >= 90)) {
        add({
          kind: 'slow-hop',
          deviceId: d.cfg.id,
          severity: 'warning',
          title: `The hop into ${d.cfg.site} adds ${Math.round(b - a)} ms`,
          why: `The link figures look healthy (capacity ${cap ?? '?'}%), so the delay isn't signal. It is the radios waiting for airtime: interference on the channel, or two radios on the same mast hearing each other.`,
          fix: `Move this link to a 5 GHz channel well away from any other link on the same mast, and if two radios share that mast, put more distance or a metal plate between them. Backbone changes are left to you.`,
        });
      }
    }
  }

  // ---- gateway: DHCP pool and backbone load ----
  const g = inp.gateway;
  if (g?.stats) {
    for (const n of g.stats.networks) {
      if (!n.poolSize || n.clients < 0.85 * n.poolSize) continue;
      const hrs = n.leaseSeconds ? Math.round(n.leaseSeconds / 3600) : null;
      out.push({
        id: `dhcp-full:${g.id}:${n.name}`,
        kind: 'dhcp-full',
        deviceId: g.id,
        deviceName: g.name,
        severity: n.clients >= n.poolSize ? 'serious' : 'warning',
        title: `${n.name} is running out of addresses`,
        why: `${n.clients} devices are active on a DHCP range of ${n.poolSize}${hrs ? `, with ${hrs}-hour leases` : ''}. When it fills, new phones connect to the WiFi but never get an address, and show "no internet".`,
        fix: `In UniFi, open the ${n.name} network: widen the DHCP range${hrs && hrs > 4 ? ` and cut the lease time from ${hrs} hours to 2 to 4 hours, so addresses from phones that have left come back quickly` : ''}.`,
      });
    }
  }
  const w = g?.stats?.watch;
  if (g && w?.floodPps != null && w.floodPps >= FLOOD_WARN_PPS) {
    const fromGw = w.floodFromGatewayPps ?? null;
    const mostlyGw = fromGw !== null && fromGw >= w.floodPps / 2;
    out.push({
      id: `flood:${g.id}`,
      kind: 'flood',
      deviceId: g.id,
      deviceName: g.name,
      severity: w.floodPps >= FLOOD_SERIOUS_PPS ? 'serious' : 'warning',
      title: `Broadcast flood: ${w.floodPps} packets a second on the radios`,
      why: `Broadcast and multicast packets go to every device on every AP, at the slowest rate, so they eat airtime everyone shares. After the mDNS fix the park ran at about 50 a second; ${w.floodPps} is the level that caused the "connected, no internet" waves.${fromGw !== null ? ` ${fromGw} a second come from ${g.name} itself.` : ''}`,
      fix: mostlyGw
        ? `Most of it comes from ${g.name}. In UniFi check Settings, Networks, Multicast and mDNS: the mDNS proxy must not include the Lookout & Monks network, and IGMP snooping should be on. Undo any change made there recently.`
        : `Most of it comes from a device on the radios. Capture on a laptop on the park WiFi (pktmon) to find the MAC, then block it on its AP with the MAC ACL. Fire Sticks, Chromecasts and smart watches are the usual culprits.`,
    });
  }
  if (g && g.peakDown95 !== null && g.samples >= MIN_LOAD_SAMPLES && g.capacity > 0) {
    const pct = Math.round((g.peakDown95 / g.capacity) * 100);
    if (pct >= 80) {
      out.push({
        id: `backbone-full:${g.id}`,
        kind: 'backbone-full',
        deviceId: g.id,
        deviceName: g.name,
        severity: pct >= 95 ? 'serious' : 'warning',
        title: `The backbone is nearly full at busy times`,
        why: `At its busiest, traffic to Lookout & Monks reaches ${g.peakDown95} Mbps (95th percentile of the last 3 days), ${pct}% of the ${g.capacity} Mbps the link can really carry. Everyone beyond the house shares that.`,
        fix: `Splitting the load helps here: a second feed for Mast 2 and Monks (Starlink at Monks, say) would take their share off this link. Per-device speed limits on UDR3 also stop a few heavy users filling it.`,
      });
    }
  }

  return out.sort((x, y) => RANK[x.severity] - RANK[y.severity]);
}

/** Severity used for alert-style colouring. */
export const suggestionHealth = (s: Suggestion['severity']): Severity | 'good' => (s === 'info' ? 'good' : s);
