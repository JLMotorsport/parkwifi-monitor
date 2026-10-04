// Shared types: imported by the Node core and by the React dashboard.

export type Role = 'backbone-ap' | 'backbone-sta' | 'ap' | 'unknown';

export interface DeviceCfg {
  id: string;
  name: string;
  ip: string;
  site: string;
  /** 'auto' = work it out from the radio's wireless mode on each poll */
  role: Role | 'auto';
  enabled: boolean;
}

export interface Probe {
  id: string;
  name: string;
  host: string;
}

export interface Thresholds {
  /** average ping (ms) above which a device is flagged slow */
  latencyMs: number;
  /** packet loss (%) above which a device is flagged lossy */
  lossPct: number;
  /** backbone link CCQ (%) floor */
  backboneCcq: number;
  /** backbone airMAX capacity (%) floor */
  backboneCapacity: number;
  /** a client weaker than this (dBm) counts as "weak" */
  weakSignal: number;
  /** AP noise floor (dBm) above which it is flagged noisy */
  apNoise: number;
  /** consecutive bad polls before an alert is raised */
  sustainPolls: number;
}

export interface Config {
  username: string;
  /** stored encrypted when running inside Electron ("enc:"), otherwise "plain:" */
  passwordEnc: string;
  pollSeconds: number;
  pingCount: number;
  pingSize: number;
  devices: DeviceCfg[];
  probes: Probe[];
  /** device ids, house to furthest point, used to draw the backbone and per-hop latency */
  chain: string[];
  thresholds: Thresholds;
  notifications: boolean;
  retentionDays: number;
  server: { port: number; allowRemote: boolean; token: string };
  /** web port the airOS speed test uses to log into the target radio (it uses plain HTTP) */
  speedTestPort?: number;
  /** set once the app has switched "Start with Windows" on for the first time */
  autostartInitialised?: boolean;
}

export interface PingResult {
  sent: number;
  received: number;
  lossPct: number;
  avg: number | null;
  min: number | null;
  max: number | null;
}

export interface Station {
  mac: string;
  name: string;
  ip: string;
  signal: number | null;
  noise: number | null;
  ccq: number | null;
  txRate: number | null;
  rxRate: number | null;
  latency: number | null;
  uptime: number | null;
  distanceM: number | null;
}

export interface RadioStatus {
  hostname: string;
  model: string;
  firmware: string;
  uptime: number | null;
  mode: string;
  wds: boolean;
  essid: string;
  frequency: number | null;
  channel: number | null;
  channelWidth: number | null;
  signal: number | null;
  noise: number | null;
  ccq: number | null;
  txRate: number | null;
  rxRate: number | null;
  txPower: number | null;
  airmaxQuality: number | null;
  airmaxCapacity: number | null;
  stationCount: number | null;
  cpu: number | null;
  memPct: number | null;
  lanSpeed: number | null;
  security: string;
}

/** One poll of one device or probe. Compact on purpose: these are stored for every minute. */
export interface Sample {
  t: number;
  id: string;
  ping: PingResult;
  radio?: RadioStatus;
  stations?: { count: number; weak: number; avgSignal: number | null; worstSignal: number | null; noIp: number };
  error?: string;
}

export type Severity = 'warning' | 'serious' | 'critical';

export interface AlertItem {
  key: string;
  deviceId: string;
  deviceName: string;
  severity: Severity;
  title: string;
  detail: string;
  startedAt: number;
  resolvedAt?: number;
  /** true for one-off events (reboot, channel change) rather than ongoing conditions */
  event?: boolean;
}

export interface DeviceState {
  cfg: DeviceCfg;
  role: Role;
  latest?: Sample;
  stationsLive?: Station[];
  health: 'good' | 'warning' | 'serious' | 'critical' | 'unknown';
}

export interface UpdateInfo {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'none' | 'error' | 'unsupported';
  version?: string;
  progress?: number;
  message?: string;
}

export interface AppState {
  now: number;
  version: string;
  lastPoll: number | null;
  polling: boolean;
  nextPoll: number | null;
  devices: DeviceState[];
  probes: { probe: Probe; latest?: Sample }[];
  chain: string[];
  alerts: AlertItem[];
  events: AlertItem[];
  update: UpdateInfo;
  autostart: boolean | null;
  needsSetup: boolean;
  /** device id currently running a speed test, if any */
  speedTestRunning: string | null;
}

export interface PublicConfig extends Omit<Config, 'passwordEnc'> {
  hasPassword: boolean;
}

export interface SpeedTestRecord {
  t: number;
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  direction: 'dx' | 'tx' | 'rx';
  duration: number;
  port: number;
  ok: boolean;
  /** Mbps from the testing radio towards the target */
  tx: number | null;
  /** Mbps from the target back to the testing radio */
  rx: number | null;
  message: string;
}
