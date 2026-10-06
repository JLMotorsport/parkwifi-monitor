import fs from 'fs';
import path from 'path';
import type { AlertItem, Sample, SpeedTestRecord } from './types';

const DAY = 24 * 3600 * 1000;
const MEMORY_HOURS = 48;

/**
 * History on disk as one JSON-lines file per day (history/2026-10-04.jsonl), so nothing
 * needs a native database module. The last 48 hours are kept in memory for fast charts.
 */
export class HistoryStore {
  private dir: string;
  private alertsFile: string;
  private speedFile: string;
  private mem = new Map<string, Sample[]>();

  constructor(dataDir: string, private retentionDays: number) {
    this.dir = path.join(dataDir, 'history');
    this.alertsFile = path.join(dataDir, 'alerts.jsonl');
    this.speedFile = path.join(dataDir, 'speedtests.jsonl');
    fs.mkdirSync(this.dir, { recursive: true });
    this.loadRecent();
    this.prune();
  }

  private fileFor(t: number) {
    return path.join(this.dir, new Date(t).toISOString().slice(0, 10) + '.jsonl');
  }

  private loadRecent() {
    const since = Date.now() - MEMORY_HOURS * 3600 * 1000;
    for (const s of this.readFiles(since, Date.now())) this.remember(s);
  }

  private remember(s: Sample) {
    let arr = this.mem.get(s.id);
    if (!arr) this.mem.set(s.id, (arr = []));
    arr.push(s);
    const cutoff = Date.now() - MEMORY_HOURS * 3600 * 1000;
    while (arr.length && arr[0].t < cutoff) arr.shift();
  }

  add(samples: Sample[]) {
    if (!samples.length) return;
    for (const s of samples) this.remember(s);
    const lines = samples.map((s) => JSON.stringify(s)).join('\n') + '\n';
    fs.appendFile(this.fileFor(samples[0].t), lines, () => undefined);
  }

  private *readFiles(from: number, to: number): Generator<Sample> {
    for (let d = Math.floor(from / DAY) * DAY; d <= to; d += DAY) {
      const f = this.fileFor(d);
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          const s = JSON.parse(line) as Sample;
          if (s.t >= from && s.t <= to) yield s;
        } catch {
          /* partial line from a crash: skip */
        }
      }
    }
  }

  /** Samples for one device, thinned to at most maxPoints by keeping evenly spaced ones plus the worst ping. */
  range(id: string, hours: number, maxPoints = 600): Sample[] {
    const to = Date.now();
    const from = to - hours * 3600 * 1000;
    let rows: Sample[];
    if (hours <= MEMORY_HOURS) rows = (this.mem.get(id) ?? []).filter((s) => s.t >= from);
    else rows = [...this.readFiles(from, to)].filter((s) => s.id === id);
    if (rows.length <= maxPoints) return rows;
    const bucket = Math.ceil(rows.length / maxPoints);
    const out: Sample[] = [];
    for (let i = 0; i < rows.length; i += bucket) {
      const slice = rows.slice(i, i + bucket);
      // keep the worst sample so spikes survive thinning: busiest minute for gateways, worst ping otherwise
      const score = (s: Sample) => s.gw?.watch?.downPeak ?? s.ping.max ?? -1;
      out.push(slice.reduce((a, b) => (score(b) > score(a) ? b : a)));
    }
    return out;
  }

  previous(id: string): Sample | undefined {
    const arr = this.mem.get(id);
    return arr && arr.length ? arr[arr.length - 1] : undefined;
  }

  logAlert(a: AlertItem) {
    fs.appendFile(this.alertsFile, JSON.stringify(a) + '\n', () => undefined);
  }

  recentAlerts(limit = 200): AlertItem[] {
    try {
      const lines = fs.readFileSync(this.alertsFile, 'utf8').trim().split('\n').slice(-limit * 2);
      const out: AlertItem[] = [];
      for (const l of lines) {
        try {
          out.push(JSON.parse(l));
        } catch {
          /* skip */
        }
      }
      return out.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  logSpeedTest(r: SpeedTestRecord) {
    fs.appendFileSync(this.speedFile, JSON.stringify(r) + '\n');
  }

  speedTests(deviceId?: string, limit = 50): SpeedTestRecord[] {
    try {
      const rows = fs
        .readFileSync(this.speedFile, 'utf8')
        .trim()
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l) as SpeedTestRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is SpeedTestRecord => !!r && (!deviceId || r.fromId === deviceId || r.toId === deviceId));
      return rows.slice(-limit).reverse();
    } catch {
      return [];
    }
  }

  prune() {
    const cutoff = Date.now() - this.retentionDays * DAY;
    for (const f of fs.readdirSync(this.dir)) {
      const t = Date.parse(f.slice(0, 10));
      if (Number.isFinite(t) && t < cutoff - DAY) fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}
