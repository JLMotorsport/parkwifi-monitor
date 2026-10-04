import { execFile } from 'child_process';
import type { PingResult } from './types';

/**
 * Uses the operating system's own ping (no admin rights or raw sockets needed).
 * Windows: ping -n COUNT -w TIMEOUT -l SIZE host
 * Linux/macOS: ping -c COUNT -i 0.2 -W 1 -s SIZE host
 */
export function ping(host: string, count: number, size: number, timeoutMs = 1000): Promise<PingResult> {
  const win = process.platform === 'win32';
  const args = win
    ? ['-n', String(count), '-w', String(timeoutMs), '-l', String(size), host]
    : ['-c', String(count), '-i', '0.2', '-W', String(Math.ceil(timeoutMs / 1000)), '-s', String(size), host];
  const budget = count * (timeoutMs + 1200) + 3000;
  return new Promise((resolve) => {
    execFile('ping', args, { timeout: budget, windowsHide: true }, (_err, stdout) => {
      // ping exits non-zero when any packet is lost; the output is still what we want.
      resolve(parsePing(String(stdout ?? ''), count));
    });
  });
}

/**
 * Pulls every reply time out of ping output. Counts only genuine replies (Windows prints
 * "Reply from x: Destination host unreachable" with no time, which must not count).
 */
export function parsePing(out: string, sent: number): PingResult {
  const times: number[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (!/ttl[=:]/i.test(line)) continue;
    const m = line.match(/time\s*[=<]\s*([\d.,]+)\s*ms/i);
    if (m) times.push(parseFloat(m[1].replace(',', '.')));
  }
  const received = Math.min(times.length, sent);
  const lossPct = sent > 0 ? Math.round(((sent - received) / sent) * 1000) / 10 : 100;
  if (!times.length) return { sent, received: 0, lossPct: 100, avg: null, min: null, max: null };
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  return {
    sent,
    received,
    lossPct,
    avg: Math.round(avg * 10) / 10,
    min: Math.min(...times),
    max: Math.max(...times),
  };
}
