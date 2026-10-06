// Development aid: fake airOS 6 radios on 127.0.0.x:443 so the monitor can be exercised
// without the real network. Needs a cert pair in scripts/mock-cert (see README).
//   node scripts/mock-radios.mjs
import https from 'https';
import http from 'http';
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
  '127.0.0.35': { host: 'Lookout AP#5 (http only)', model: 'NanoStation M2', mode: 'ap', wds: 0, freq: 2412, ch: 1, noise: -88, ccq: 880, up: 300000, txpower: 17, httpOnly: true,
    sta: [['AA:BB:CC:00:11:22', '192.168.2.120', -62, 65, 52, 90, 2]] },
  '127.0.0.36': { host: 'Lookout AP#6 (https redirects)', model: 'NanoStation M2', mode: 'ap', wds: 0, freq: 2437, ch: 6, noise: -90, ccq: 910, up: 300000, txpower: 17, httpsRedirect: true,
    sta: [] },
  '127.0.0.42': { host: 'Monks AP#4 (MM)', model: 'NanoBeam M2', mode: 'ap', wds: 0, freq: 2457, ch: 10, noise: -89, ccq: 940, up: 790000, txpower: 20,
    sta: [['3A:57:9D:9C:14:74', '192.168.2.88', -64, 26, 78, 93, 3]] },
};

// Mimics airOS 6 (XM): the login page sets an AIROS_<mac> cookie, the form is urlencoded,
// and the session only becomes usable after /index.cgi has been loaded once.
const pending = new Set();
const sessions = new Set();
const tests = new Map(); // ticket -> { started, duration, port }
const jitter = (v, a) => (v === undefined ? undefined : Math.round((v + (Math.random() - 0.5) * a) * 10) / 10);
const cookie = (req) => (req.headers.cookie ?? '').match(/AIROS_[0-9A-F]{12}=([0-9a-f]+)/)?.[1];

function status(r) {
  applyCfg(r);
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
  const serve = (handler) => {
    if (r.httpOnly) return http.createServer(handler).listen(80, ip);
    if (r.httpsRedirect) {
      http.createServer(handler).listen(80, ip);
      return https.createServer(tls, (req, res) => { res.writeHead(302, { Location: `http://${ip}${req.url}` }); res.end(); }).listen(443, ip);
    }
    return https.createServer(tls, handler).listen(443, ip, () => console.log('mock airOS', ip, r.host));
  };
  const mac = '0027226447' + ip.split('.')[3].padStart(2, '0');
  serve((req, res) => {
      const sid = cookie(req);
      if (req.url.startsWith('/login.cgi')) {
        if (req.method === 'GET') {
          const fresh = sid ?? Math.random().toString(16).slice(2).padEnd(32, '0');
          res.writeHead(200, { 'Content-Type': 'text/html', 'Set-Cookie': `AIROS_${mac}=${fresh}; Path=/; HttpOnly` });
          return res.end('<html><title>airOS</title><form method=post><input name="username"><input name="password" type=password></form></html>');
        }
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const f = new URLSearchParams(body);
          const ok = req.headers['content-type']?.includes('urlencoded') && f.get('username') === USER && f.get('password') === PASS;
          if (ok && sid) {
            pending.add(ip + sid);
            res.writeHead(302, { Location: f.get('uri') ?? '/index.cgi' });
            return res.end();
          }
          res.writeHead(302, { Location: '/login.cgi?uri=/index.cgi' });
          res.end();
        });
        return;
      }
      if (req.url.startsWith('/index.cgi') && sid && pending.has(ip + sid)) {
        sessions.add(ip + sid);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<html>main</html>');
      }
      if (!sid || !sessions.has(ip + sid)) {
        res.writeHead(302, { Location: '/login.cgi' });
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (req.url.startsWith('/status.cgi')) return res.end(JSON.stringify(status(r)));
      if (req.url.startsWith('/sptest_action.cgi')) {
        // airOS speed test: fails (flags 2) when asked to log into the target on 443, like the real radios
        const q = new URL(req.url, 'http://x').searchParams;
        const t = q.get('ticket');
        const a = q.get('action');
        if (a === 'remote') return res.end('{ "status" : 0, "message" : "Success." }');
        if (a === 'start') {
          tests.set(t, { started: Date.now(), duration: Number(q.get('duration') ?? 30), port: q.get('port'), dir: q.get('direction') });
          return res.end(JSON.stringify({ status: 0, message: 'Success.', session: Number(t), state: 1, flags: 0, duration: 0, tx: 2809.1, rx: 781.3, microtime: '0.3 1733404338' }));
        }
        if (a === 'status') {
          const x = tests.get(t);
          if (!x || x.port === '443') return res.end(JSON.stringify({ status: 0, message: 'Success.', session: Number(t), state: 10, flags: 2, duration: 10, tx: 0, rx: 0, microtime: '0.5 1733404344' }));
          const done = Date.now() - x.started > Math.min(x.duration, 4) * 1000;
          const tx = x.dir === 'rx' ? 0 : 38.42, rx = x.dir === 'tx' ? 0 : 61.07;
          return res.end(JSON.stringify({ status: 0, message: 'Success.', session: Number(t), state: done ? 10 : 2, flags: 0, duration: 10, tx: done ? tx : 1000, rx: done ? rx : 1000, microtime: '0.5 1733404344' }));
        }
        return res.end('{ "status" : 0, "message" : "Success." }');
      }
      if (req.url.startsWith('/sta.cgi')) {
        const list = (r.sta ?? []).map(([mac, lastip, signal, tx, rx, ccq, lat]) => ({
          mac, lastip, signal: Math.round(jitter(signal, 4)), tx, rx, ccq, txlatency: lat, uptime: 600 + Math.round((Date.now() - boot) / 1000), noisefloor: r.noise,
        }));
        return res.end(JSON.stringify(list));
      }
      res.end('{}');
  });
}

// ---- SSH, for the change feature -------------------------------------------------------------
// Each access point gets a little filesystem under /tmp/pwm-mock/<ip>: tmp/system.cfg and a fake
// rc.softrestart that "applies" it by copying to applied.cfg. Commands from the app run in a real
// shell with the radio paths rewritten into that folder, so the exact scripts the app sends are
// exercised, including the nohup undo timer.
import { execFile } from 'child_process';
import ssh2 from 'ssh2';
import { generateKeyPairSync } from 'crypto';
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } }).privateKey;
const ROOT = '/tmp/pwm-mock';
function applyCfg(r) {
  if (!r.dir) return;
  try {
    const kv = Object.fromEntries(fs.readFileSync(path.join(r.dir, 'applied.cfg'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('=')));
    if (kv['radio.1.txpower']) r.txpower = Number(kv['radio.1.txpower']);
    if (kv['radio.1.freq']) { r.freq = Number(kv['radio.1.freq']); r.ch = (r.freq - 2407) / 5; }
  } catch { /* not applied yet */ }
}
for (const [ip, r] of Object.entries(radios)) {
  if (r.mode !== 'ap' || r.wds) continue;
  r.dir = path.join(ROOT, ip);
  fs.rmSync(r.dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(r.dir, 'tmp'), { recursive: true });
  const cfg = `aaa.1.status=enabled\nradio.1.mode=master\nradio.1.freq=${r.freq}\nradio.1.txpower=${r.txpower ?? 20}\nradio.1.chanbw=20\nwireless.1.ssid=Lookout & Monks Meadow\n`;
  fs.writeFileSync(path.join(r.dir, 'tmp/system.cfg'), cfg);
  fs.writeFileSync(path.join(r.dir, 'applied.cfg'), cfg);
  fs.writeFileSync(path.join(r.dir, 'softrestart'), `#!/bin/sh\necho "$(date +%T) softrestart $1" >> ${r.dir}/log\ncp ${r.dir}/tmp/system.cfg ${r.dir}/applied.cfg\n`, { mode: 0o755 });
  const server = new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
    client
      .on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS ? ctx.accept() : ctx.reject(['password'])))
      .on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.on('exec', (acc, _rej, info) => {
            const stream = acc();
            const cmd = info.command.replaceAll('/tmp/', `${r.dir}/tmp/`).replaceAll('/usr/etc/rc.d/rc.softrestart', `${r.dir}/softrestart`);
            fs.appendFileSync(path.join(r.dir, 'log'), `$ ${info.command.split('\n').join(' ; ')}\n`);
            execFile(process.env.MOCK_SH ?? 'sh', [...(process.env.MOCK_SH ? ['sh'] : []), '-c', cmd], (err, out) => {
              stream.write(out);
              stream.exit(err ? 1 : 0);
              stream.end();
            });
          });
        });
      })
      .on('error', () => undefined);
  });
  server.listen(22, ip, () => console.log('mock ssh', ip));
}

// ---- UniFi OS gateway (UDR3) on 127.0.0.178 --------------------------------------------------
{
  const ip = '127.0.0.178';
  const start = Date.now();
  let lastT = start;
  const ctr = { p3rx: 0, p3tx: 0, wrx: 0, wtx: 0 };
  const tick = () => {
    const now = Date.now();
    const dt = (now - lastT) / 1000;
    lastT = now;
    const burst = Math.random() < 0.15 ? 2.5 : 1;
    const down = (14 + Math.random() * 16) * burst; // Mbps towards the caravans
    const up = 1.5 + Math.random() * 3;
    ctr.p3tx += (down * 1e6 * dt) / 8;
    ctr.p3rx += (up * 1e6 * dt) / 8;
    ctr.wrx += ((down + 20) * 1e6 * dt) / 8;
    ctr.wtx += ((up + 3) * 1e6 * dt) / 8;
  };
  const send = (res, data) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ meta: { rc: 'ok' }, data })); };
  https.createServer(tls, (req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/api/auth/login') {
        const b = JSON.parse(body || '{}');
        if (b.username !== USER || b.password !== PASS) { res.writeHead(401); return res.end('{}'); }
        res.writeHead(200, { 'Set-Cookie': 'TOKEN=mocktoken; Path=/; HttpOnly', 'X-CSRF-Token': 'csrf123', 'Content-Type': 'application/json' });
        return res.end('{}');
      }
      if (!(req.headers.cookie ?? '').includes('TOKEN=mocktoken')) { res.writeHead(401); return res.end('{}'); }
      const p = req.url.replace('/proxy/network/api/s/default/', '');
      tick();
      if (p === 'stat/health') return send(res, [{ subsystem: 'www', status: 'ok', latency: Math.round(11 + Math.random() * 6) }, { subsystem: 'wan', status: 'ok' }]);
      if (p === 'stat/device') return send(res, [{
        type: 'udm', model: 'UDR', name: 'UDR3 House', uptime: 864000 + Math.round((Date.now() - start) / 1000), 'system-stats': { cpu: '9.1', mem: '58.2' },
        port_table: [
          { port_idx: 1, name: 'Port 1', up: true, speed: 1000, rx_bytes: 1000, tx_bytes: 1000 },
          { port_idx: 2, name: 'House LAN', up: true, speed: 1000, rx_bytes: 5000, tx_bytes: 9000 },
          { port_idx: 3, name: 'Lookout&Monks', up: true, speed: 100, rx_bytes: Math.round(ctr.p3rx), tx_bytes: Math.round(ctr.p3tx) },
          { port_idx: 4, name: 'Port 4', up: false, speed: 0, rx_bytes: 0, tx_bytes: 0 },
        ],
        wan1: { rx_bytes: Math.round(ctr.wrx), tx_bytes: Math.round(ctr.wtx) },
      }]);
      if (p === 'rest/networkconf') return send(res, [
        { _id: 'n1', name: 'Lookout&Monks', purpose: 'corporate', ip_subnet: '192.168.2.1/24', dhcpd_enabled: true, dhcpd_start: '192.168.2.100', dhcpd_stop: '192.168.2.199', dhcpd_leasetime: 86400 },
        { _id: 'n2', name: 'House', purpose: 'corporate', ip_subnet: '192.168.10.1/24', dhcpd_enabled: true, dhcpd_start: '192.168.10.6', dhcpd_stop: '192.168.10.254', dhcpd_leasetime: 86400 },
        { _id: 'w1', name: 'Internet 1', purpose: 'wan' },
      ]);
      if (p === 'stat/sta') return send(res, [...Array(91).fill({ network_id: 'n1' }), ...Array(14).fill({ network_id: 'n2' })]);
      res.writeHead(404); res.end('{}');
    });
  }).listen(443, ip, () => console.log('mock UniFi gateway', ip));
}
