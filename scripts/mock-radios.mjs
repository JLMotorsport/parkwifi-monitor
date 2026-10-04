// Development aid: fake airOS 6 radios on 127.0.0.x:443 so the monitor can be exercised
// without the real network. Needs a cert pair in scripts/mock-cert (see README).
//   node scripts/mock-radios.mjs
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-cert');
const tls = { key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) };
const USER = 'ubnt';
const PASS = 'test-pass';
const boot = Date.now();

const radios = {
  '127.0.0.21': { host: 'House-Lookout Sender (House)', model: 'NanoStation M5', mode: 'ap', wds: 1, freq: 5540, ch: 108, noise: -89, ccq: 991, up: 670000 },
  '127.0.0.22': { host: 'House-Lookout Station (8L)', model: 'NanoStation M5', mode: 'sta', wds: 1, freq: 5540, ch: 108, signal: -52, noise: -90, ccq: 991, tx: 130, rx: 130, q: 99, c: 98, up: 670000 },
  '127.0.0.23': { host: 'Lookout-Lookout Sender (8L)', model: 'NanoBeam M5 16', mode: 'ap', wds: 1, freq: 5800, ch: 160, noise: -106, ccq: 991, up: 5170000 },
  '127.0.0.24': { host: 'Lookout-Lookout Station (73L)', model: 'NanoStation M5', mode: 'sta', wds: 1, freq: 5800, ch: 160, signal: -53, noise: -85, ccq: 969, tx: 52, rx: 130, q: 90, c: 66, up: 5170000 },
  '127.0.0.26': { host: 'Lookout-Monks Station (MM)', model: 'NanoStation M5', mode: 'sta', wds: 1, freq: 5580, ch: 116, signal: -58, noise: -92, ccq: 985, tx: 117, rx: 130, q: 97, c: 95, up: 5170000 },
  '127.0.0.31': { host: 'Lookout AP#1 (8L)', model: 'NanoStation M2', mode: 'ap', wds: 0, freq: 2412, ch: 1, noise: -79, ccq: 366, up: 4950000, txpower: 20,
    sta: [['14:91:38:86:C9:D1', '192.168.2.19', -81, 6.5, 6, 31, 12], ['CC:D4:2E:11:4E:66', '192.168.2.222', -89, 6.5, 1, 55, 4], ['F4:03:2A:0C:9B:4F', '', -82, 6, 0, 0, 4]] },
  '127.0.0.33': { host: 'Lookout AP#3 (8L)', model: 'NanoStation M2', mode: 'ap', wds: 0, freq: 2452, ch: 9, noise: -96, ccq: 730, up: 4950000, txpower: 20,
    sta: [['60:02:B4:B8:32:A9', '192.168.2.68', -85, 130, 2, 40, 1], ['16:CC:EA:7B:76:87', '192.168.2.191', -66, 52, 39, 71, 3]] },
  '127.0.0.37': { host: 'Lookout AP#7 (73L)', model: 'NanoStation M2', mode: 'ap', wds: 0, freq: 2457, ch: 10, noise: -84, ccq: 624, up: 600, txpower: 20,
    sta: [['60:02:B4:46:FB:5A', '192.168.2.205', -58, 117, 52, 92, 5], ['9A:0E:4E:5B:84:E5', '192.168.2.150', -75, 26, 19.5, 52, 209], ['AA:42:A1:05:28:4C', '192.168.2.218', -74, 78, 6.5, 25, 31]] },
  '127.0.0.42': { host: 'Monks AP#4 (MM)', model: 'NanoBeam M2', mode: 'ap', wds: 0, freq: 2457, ch: 10, noise: -89, ccq: 940, up: 790000, txpower: 20,
    sta: [['3A:57:9D:9C:14:74', '192.168.2.88', -64, 26, 78, 93, 3]] },
};

const sessions = new Set();
const jitter = (v, a) => (v === undefined ? undefined : Math.round((v + (Math.random() - 0.5) * a) * 10) / 10);
const cookie = (req) => (req.headers.cookie ?? '').match(/AIROS_SESSIONID=([0-9a-f]+)/)?.[1];

function status(r) {
  const up = r.up + Math.round((Date.now() - boot) / 1000);
  return {
    host: { hostname: r.host, devmodel: r.model, fwversion: 'XM.v6.3.16', uptime: up, totalram: 30000, freeram: 6000, cpuload: 7 },
    wireless: {
      mode: r.mode, wds: r.wds, essid: r.mode === 'ap' && !r.wds ? 'Lookout & Monks Meadow' : 'pp02', frequency: `${r.freq} MHz`, channel: r.ch,
      chwidth: 20, signal: r.signal !== undefined ? Math.round(jitter(r.signal, 3)) : undefined, noisef: r.noise, ccq: r.ccq,
      txrate: String(r.tx ?? ''), rxrate: String(r.rx ?? ''), txpower: r.txpower ?? 20, count: r.sta?.length ?? 1, security: r.wds ? 'WPA2' : 'none',
      polling: r.q !== undefined ? { quality: r.q, capacity: r.c } : undefined,
    },
    interfaces: [{ ifname: 'eth0', status: { plugged: 1, speed: 100, duplex: 1 } }],
  };
}

for (const [ip, r] of Object.entries(radios)) {
  https
    .createServer(tls, (req, res) => {
      const sid = cookie(req);
      if (req.url.startsWith('/login.cgi')) {
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          return res.end('<html><title>airOS</title><form method=post><input name="username"><input name="password" type=password></form></html>');
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const ok = body.includes(`name="username"\r\n\r\n${USER}\r\n`) && body.includes(`name="password"\r\n\r\n${PASS}\r\n`);
          if (ok && sid) {
            sessions.add(ip + sid);
            res.writeHead(302, { Location: '/index.cgi' });
            return res.end();
          }
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html>Invalid credentials<form><input name="password" type=password></form></html>');
        });
        return;
      }
      if (!sid || !sessions.has(ip + sid)) {
        res.writeHead(302, { Location: '/login.cgi' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/status.cgi')) return res.end(JSON.stringify(status(r)));
      if (req.url.startsWith('/sta.cgi')) {
        const list = (r.sta ?? []).map(([mac, lastip, signal, tx, rx, ccq, lat]) => ({
          mac, lastip, signal: Math.round(jitter(signal, 4)), tx, rx, ccq, txlatency: lat, uptime: 600 + Math.round((Date.now() - boot) / 1000), noisefloor: r.noise,
        }));
        return res.end(JSON.stringify(list));
      }
      res.end('{}');
    })
    .listen(443, ip, () => console.log('mock airOS', ip, r.host));
}
