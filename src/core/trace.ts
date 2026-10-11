// Path test: ping every hop on the way to a radio once a second, all at the same time, then work
// out where delay spikes start. A spike that appears at hop k and at every hop after it was added
// on the link into hop k. A spike at one radio only, with the hops after it fine, is that radio
// being slow to answer ping while busy, not delay on the path, so it is not blamed. Pure.
import type { RadioStatus, TraceHop, TraceResult } from './types';

/** A reply this much slower than the hop's own median counts as a spike. */
export const SPIKE_MS = 50;

export interface TraceInput {
  hops: { id: string; name: string; role: string; series: (number | null)[]; radio?: RadioStatus; clients?: number; weakest?: number | null }[];
  /** traffic on the UDR3 port feeding the radios during the test, and what the backbone can carry */
  backboneMbps: number | null;
  capacity: number;
  floodPps: number | null;
}

const r1 = (x: number | null) => (x === null ? null : Math.round(x * 10) / 10);
const ms = (x: number | null) => (x === null ? '?' : `${Math.round(x)} ms`);
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pctile = (xs: number[], p: number) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
};

export function analyseTrace(inp: TraceInput): Omit<TraceResult, 'id' | 'targetId' | 'targetName' | 'reason' | 'startedAt' | 'seconds'> {
  const hops: TraceHop[] = inp.hops.map((h) => {
    const ok = h.series.filter((x): x is number => x !== null);
    return {
      id: h.id,
      name: h.name,
      series: h.series,
      median: r1(median(ok)),
      p95: r1(pctile(ok, 0.95)),
      worst: ok.length ? r1(Math.max(...ok)) : null,
      lossPct: h.series.length ? Math.round(((h.series.length - ok.length) / h.series.length) * 100) : 100,
      addedMedian: null,
      spikesStartHere: 0,
    };
  });
  hops.forEach((h, i) => {
    const prev = i > 0 ? hops[i - 1].median : 0;
    h.addedMedian = h.median !== null && prev !== null ? Math.round((h.median - prev) * 10) / 10 : null;
  });

  const n = Math.max(0, ...hops.map((h) => h.series.length));
  const bad = (k: number, i: number) => {
    const v = hops[k].series[i];
    const m = hops[k].median;
    return v === null || v === undefined || (m !== null && v - m > SPIKE_MS);
  };
  let spikes = 0;
  const last = hops.length - 1;
  for (let i = 0; i < n && last >= 0; i++) {
    if (!bad(last, i)) continue;
    // walk back from the far end while the hops are also bad: the spike started where that run starts
    let r = last;
    while (r > 0 && bad(r - 1, i)) r--;
    // a second where everything failed, from the first hop on, is usually this PC
    hops[r].spikesStartHere++;
    spikes++;
  }

  let culprit: number | null = null;
  if (spikes >= 3) {
    const best = hops.reduce((b, h, i) => (h.spikesStartHere > hops[b].spikesStartHere ? i : b), 0);
    if (hops[best].spikesStartHere / spikes >= 0.5) culprit = best;
  }

  const target = hops[last];
  const ctx: TraceResult['context'] = { backboneMbps: inp.backboneMbps, floodPps: inp.floodPps };
  const parts: string[] = [];
  if (!hops.length) return { hops, spikes, culprit, verdict: 'Nothing to test.', context: ctx };

  if (spikes < 3) {
    parts.push(
      `No real delay spikes in ${n} seconds: ${target.name} answered in ${ms(target.median)} typically, worst ${ms(target.worst)}. The slowness comes and goes and wasn't happening during the test; the app tests again next time an alert fires.`,
    );
  } else if (culprit === null) {
    parts.push(`${spikes} spikes in ${n} seconds, spread across several hops with no single starting point. That points at something shared by the whole path: traffic on the backbone, or this PC.`);
  } else {
    const h = hops[culprit];
    const share = `${h.spikesStartHere} of ${spikes} spikes`;
    if (culprit === 0) {
      parts.push(`${share} start at ${h.name}, the first radio from this PC. That is this PC or the house network, not the radio links.`);
    } else if (culprit === last && inp.hops[culprit].role === 'ap') {
      const c = inp.hops[culprit];
      parts.push(
        `${share} appear only at ${h.name} itself; every hop before it was steady. The backbone is fine. The AP is busy${c.clients != null ? ` (${c.clients} devices${c.weakest != null ? `, weakest at ${c.weakest} dBm` : ''})` : ''}, and slow devices on it hold everyone up.`,
      );
    } else {
      const from = hops[culprit - 1].name;
      parts.push(`${share} start on the link from ${from} to ${h.name}. Every hop before it was steady, and the spikes carry on to every hop after it.`);
      // the receiving end of a link reports its quality; check both ends for a station
      const ends = [inp.hops[culprit], inp.hops[culprit - 1]];
      const sta = ends.find((e) => e.radio && e.radio.mode.includes('sta'))?.radio ?? ends.find((e) => e.radio)?.radio;
      const busy = inp.backboneMbps !== null && inp.capacity > 0 && inp.backboneMbps >= inp.capacity * 0.7;
      if (sta) ctx.culpritLink = `CCQ ${sta.ccq ?? '?'}%, airMAX capacity ${sta.airmaxCapacity ?? '?'}%, rates ${sta.txRate ?? '?'}/${sta.rxRate ?? '?'} Mbps, signal ${sta.signal ?? '?'} dBm`;
      const weak = sta && ((sta.ccq !== null && sta.ccq < 90) || (sta.airmaxCapacity !== null && sta.airmaxCapacity < 80));
      if (busy) {
        parts.push(`The backbone was carrying ${inp.backboneMbps} Mbps, close to the ${inp.capacity} Mbps it can manage, so this is congestion: heavy downloading queues up at the slowest link.`);
      } else if (weak) {
        parts.push(`That link's own figures are poor (${ctx.culpritLink}), so the radios are resending. Check alignment, cabling and anything in the path.`);
      } else {
        parts.push(
          `Traffic was light${inp.backboneMbps !== null ? ` (${inp.backboneMbps} Mbps)` : ''} and the link figures look healthy${ctx.culpritLink ? ` (${ctx.culpritLink})` : ''}, so the radios are waiting for clear air: interference on that channel, or another radio on the same mast drowning it out. Separating radios on the same mast, or moving this link's channel, is the fix.`,
        );
      }
    }
  }
  if (inp.floodPps !== null && inp.floodPps >= 150) parts.push(`A broadcast flood was running (${inp.floodPps} packets a second), which slows every hop.`);
  return { hops, spikes, culprit, verdict: parts.join(' '), context: ctx };
}
