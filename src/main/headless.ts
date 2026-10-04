/**
 * Run the monitor without Electron, e.g. on an always-on PC or a Raspberry Pi:
 *   node dist/node/main/headless.js --data ./data [--port 8787]
 * The dashboard is then at http://<that machine>:8787 (turn on remote access in Settings
 * to reach it from other devices; they will need the access token).
 */
import path from 'path';
import fs from 'fs';
import { Monitor } from '../core/monitor';
import { startServer } from '../core/server';
import { plainSecretBox } from '../core/config';

function arg(name: string, def: string) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

async function main() {
  const dataDir = path.resolve(arg('--data', './data'));
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
  const m = new Monitor(dataDir, plainSecretBox, pkg.version, {
    notify: (a) => console.log(`[ALERT ${a.severity}] ${a.title}: ${a.detail}`),
  });
  const port = arg('--port', '');
  if (port) m.cfg.config.server.port = Number(port);
  const srv = await startServer(m, path.join(__dirname, '..', '..', 'ui'));
  console.log(`Park WiFi Monitor ${pkg.version} running. Dashboard: http://127.0.0.1:${srv.port}  data: ${dataDir}`);
  m.start();
  const stop = () => {
    m.stop();
    srv.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

void main();
