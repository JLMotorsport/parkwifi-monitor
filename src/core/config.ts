import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Config, DeviceCfg } from './types';

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(stored: string): string;
}

/** Fallback for headless mode: not encrypted, just marked. Keep the data folder private. */
export const plainSecretBox: SecretBox = {
  encrypt: (p) => 'plain:' + Buffer.from(p, 'utf8').toString('base64'),
  decrypt: (s) => (s.startsWith('plain:') ? Buffer.from(s.slice(6), 'base64').toString('utf8') : ''),
};

const dev = (id: string, name: string, ip: string, site: string): DeviceCfg => ({
  id,
  name,
  ip,
  site,
  role: 'auto',
  enabled: true,
});

/**
 * Seeded with the radios confirmed on site (Sept/Oct 2026). Anything else is found
 * with "Discover radios" in Settings, which scans 192.168.2.x for airOS logins.
 */
export function defaultConfig(): Config {
  const devices: DeviceCfg[] = [
    dev('house-sender', 'House-Lookout Sender', '192.168.2.21', 'House'),
    dev('lookout-station', 'House-Lookout Station', '192.168.2.22', 'Lookout'),
    dev('lookout-sender', 'Lookout-Mast 2 Sender', '192.168.2.23', 'Lookout'),
    dev('mast2-station', 'Lookout-Mast 2 Station', '192.168.2.24', 'Mast 2'),
    dev('monks-station', 'Mast 2-Monks Station', '192.168.2.26', 'Monks Meadow'),
    dev('lookout-ap1', 'Lookout AP#1', '192.168.2.31', 'Lookout'),
    dev('lookout-ap2', 'Lookout AP#2', '192.168.2.32', 'Lookout'),
    dev('lookout-ap3', 'Lookout AP#3', '192.168.2.33', 'Lookout'),
    dev('lookout-ap7', 'Lookout AP#7', '192.168.2.37', 'Mast 2'),
    dev('monks-ap4', 'Monks AP#4', '192.168.2.42', 'Monks Meadow'),
  ];
  return {
    username: 'ubnt',
    passwordEnc: '',
    pollSeconds: 60,
    pingCount: 5,
    pingSize: 1400,
    devices,
    probes: [
      { id: 'internet', name: 'Internet (Google DNS)', host: '8.8.8.8' },
      { id: 'udr3', name: 'House router (UDR3)', host: '192.168.2.1' },
    ],
    chain: ['house-sender', 'lookout-station', 'lookout-sender', 'mast2-station', 'monks-station'],
    thresholds: {
      latencyMs: 40,
      lossPct: 5,
      backboneCcq: 90,
      backboneCapacity: 80,
      weakSignal: -75,
      apNoise: -80,
      sustainPolls: 3,
    },
    notifications: true,
    retentionDays: 30,
    server: { port: 8787, allowRemote: false, token: crypto.randomBytes(12).toString('hex') },
  };
}

export class ConfigStore {
  private file: string;
  config: Config;

  constructor(dataDir: string, private box: SecretBox) {
    this.file = path.join(dataDir, 'config.json');
    this.config = this.load();
  }

  private load(): Config {
    const def = defaultConfig();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return {
        ...def,
        ...raw,
        thresholds: { ...def.thresholds, ...(raw.thresholds ?? {}) },
        server: { ...def.server, ...(raw.server ?? {}) },
      };
    } catch {
      this.write(def);
      return def;
    }
  }

  private write(c: Config) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(c, null, 2));
    fs.renameSync(tmp, this.file);
  }

  save() {
    this.write(this.config);
  }

  password(): string {
    try {
      return this.config.passwordEnc ? this.box.decrypt(this.config.passwordEnc) : '';
    } catch {
      return '';
    }
  }

  setPassword(p: string) {
    this.config.passwordEnc = p ? this.box.encrypt(p) : '';
  }
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'device'
  );
}
