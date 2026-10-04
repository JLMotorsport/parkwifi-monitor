import http from 'http';
import fs from 'fs';
import path from 'path';
import type { Monitor } from './monitor';
import type { Config, PublicConfig } from './types';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

export interface AppActions {
  checkUpdate?(): void;
  installUpdate?(): void;
  setAutostart?(on: boolean): void;
}

function isLocal(req: http.IncomingMessage) {
  const a = req.socket.remoteAddress ?? '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

function tokenOf(req: http.IncomingMessage, url: URL) {
  const h = req.headers['x-token'];
  if (typeof h === 'string') return h;
  const q = url.searchParams.get('token');
  if (q) return q;
  const m = (req.headers.cookie ?? '').match(/pwm_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(e);
      }
    });
  });
}

export function publicConfig(m: Monitor): PublicConfig {
  const { passwordEnc, ...rest } = m.cfg.config;
  return { ...rest, hasPassword: !!passwordEnc };
}

/**
 * Serves the dashboard and a small JSON API. Listens on 127.0.0.1 only unless
 * "Allow access from other devices" is on, in which case other machines need the token.
 */
export function startServer(m: Monitor, uiDir: string, actions: AppActions = {}): Promise<{ port: number; close(): void }> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const send = (code: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
      res.end(JSON.stringify(body));
    };

    if (!isLocal(req)) {
      const cfg = m.cfg.config.server;
      if (!cfg.allowRemote) return send(403, { error: 'Remote access is off' });
      const tok = tokenOf(req, url);
      if (tok !== cfg.token) {
        res.writeHead(401, { 'Content-Type': 'text/html' });
        return res.end(
          '<!doctype html><meta name=viewport content="width=device-width"><body style="font-family:sans-serif;padding:24px">' +
            '<h3>Park WiFi Monitor</h3><form><input name=token placeholder="Access token" style="padding:8px;width:260px"> <button>Open</button></form>',
        );
      }
      if (url.searchParams.get('token')) {
        res.setHeader('Set-Cookie', `pwm_token=${encodeURIComponent(tok)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
      }
    }

    try {
      if (url.pathname.startsWith('/api/')) {
        const route = `${req.method} ${url.pathname}`;
        switch (route) {
          case 'GET /api/state':
            return send(200, m.state());
          case 'GET /api/history': {
            const id = url.searchParams.get('id') ?? '';
            const hours = Math.min(24 * 30, Math.max(1, Number(url.searchParams.get('hours') ?? 24)));
            return send(200, m.history.range(id, hours));
          }
          case 'GET /api/raw':
            return send(200, m.rawFor(url.searchParams.get('id') ?? ''));
          case 'GET /api/config':
            return send(200, publicConfig(m));
          case 'PUT /api/config': {
            const body = (await readBody(req)) as Partial<Config> & { password?: string };
            const c = m.cfg.config;
            const allowed: (keyof Config)[] = ['username', 'pollSeconds', 'pingCount', 'pingSize', 'devices', 'probes', 'chain', 'thresholds', 'notifications', 'retentionDays', 'server'];
            for (const k of allowed) if (body[k] !== undefined) (c as unknown as Record<string, unknown>)[k] = body[k];
            if (typeof body.password === 'string' && body.password.length) m.cfg.setPassword(body.password);
            c.pollSeconds = Math.max(15, Number(c.pollSeconds) || 60);
            c.pingCount = Math.min(20, Math.max(1, Number(c.pingCount) || 5));
            m.cfg.save();
            m.configChanged();
            return send(200, publicConfig(m));
          }
          case 'POST /api/poll':
            void m.pollNow();
            return send(202, { ok: true });
          case 'POST /api/test':
            return send(200, await m.testLogin(url.searchParams.get('ip') ?? ''));
          case 'POST /api/discover': {
            const prefix = url.searchParams.get('prefix') ?? '192.168.2';
            if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(prefix)) return send(400, { error: 'bad prefix' });
            const added = await m.discover(prefix);
            return send(200, { added });
          }
          case 'POST /api/app/check-update':
            actions.checkUpdate?.();
            return send(202, { ok: !!actions.checkUpdate });
          case 'POST /api/app/install-update':
            actions.installUpdate?.();
            return send(202, { ok: !!actions.installUpdate });
          case 'POST /api/app/autostart': {
            const body = (await readBody(req)) as { on?: boolean };
            actions.setAutostart?.(!!body.on);
            return send(200, { ok: !!actions.setAutostart });
          }
        }
        return send(404, { error: 'not found' });
      }

      // static dashboard
      let file = path.normalize(path.join(uiDir, decodeURIComponent(url.pathname)));
      if (!file.startsWith(path.normalize(uiDir))) return send(400, { error: 'bad path' });
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(uiDir, 'index.html');
      if (!fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('Dashboard not built. Run npm run build:ui');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) {
      send(500, { error: (e as Error).message });
    }
  });

  const cfg = m.cfg.config.server;
  const host = cfg.allowRemote ? '0.0.0.0' : '127.0.0.1';
  return new Promise((resolve, reject) => {
    let port = cfg.port;
    const tryListen = () => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && port < cfg.port + 20) {
          port++;
          tryListen();
        } else reject(e);
      });
      server.listen(port, host, () => resolve({ port, close: () => server.close() }));
    };
    tryListen();
  });
}
