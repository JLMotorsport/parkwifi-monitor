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
  /** SSH port on the radios, used only to make changes (default 22) */
  sshPort?: number;
  /** how long a change is trialled before it is kept or undone (minutes, default 10) */
  trialMinutes?: number;
  /** UniFi gateways read for traffic, internet latency and DHCP (UDR3 first) */
  gateways?: GatewayCfg[];
  /** real-world throughput the house to Lookout backbone can carry, in Mbps */
  backboneMbps?: number;
  /** internet download (Mbps) above which a moment is logged with the devices behind it */
  spikeMbps?: number;
}

export interface GatewayCfg {
  id: string;
  name: string;
  /** address the app reaches the gateway's web interface on */
  host: string;
  username: string;
  /** encrypted like the radio password */
  passwordEnc: string;
  /** port_idx on the gateway that feeds the radios; null = pick by name (Lookout/Monks) */
  watchPort: number | null;
  enabled: boolean;
}

export interface GatewayPort {
  idx: number;
  name: string;
  up: boolean;
  speed: number | null;
  /** Mbps out of the gateway on this port: towards the caravans, i.e. their downloads */
  txMbps: number | null;
  /** Mbps into the gateway on this port: the caravans' uploads */
  rxMbps: number | null;
  /** broadcast + multicast packets per second out of this port (towards the caravans); null if not reported */
  txFloodPps?: number | null;
  /** broadcast + multicast packets per second into this port (from devices on the radios) */
  rxFloodPps?: number | null;
}

export interface GatewayNetwork {
  name: string;
  subnet: string;
  clients: number;
  /** addresses in the DHCP range, null when DHCP is off on this network */
  poolSize: number | null;
  leaseSeconds: number | null;
}

export interface GatewayStats {
  name: string;
  model: string;
  uptime: number | null;
  cpu: number | null;
  mem: number | null;
  /** the gateway's own measurement of internet latency */
  wanLatency: number | null;
  wanUp: boolean | null;
  wanDownMbps: number | null;
  wanUpMbps: number | null;
  ports: GatewayPort[];
  networks: GatewayNetwork[];
  /** the radio-feeding port over the last minute: average and busiest 15 s reading */
  watch?: {
    idx: number;
    name: string;
    downMbps: number;
    upMbps: number;
    downPeak: number;
    upPeak: number;
    readings: number;
    /** broadcast + multicast packets/s both ways over the minute (what every device on the radios has to hear) */
    floodPps?: number | null;
    floodPeakPps?: number | null;
    /** of which sent by UDR3 itself (mDNS proxy etc.) */
    floodFromGatewayPps?: number | null;
  };
  /** devices that moved the most data over the minute */
  top?: TopClient[];
  /** the busiest 15 s internet reading in the minute, and the devices behind it */
  peak?: { t: number; totalDown: number; clients: TopClient[] } | null;
  /** false when UniFi's traffic identification gave nothing (switched off, or not supported) */
  dpiOk?: boolean;
}

/** A device using the internet connection through a gateway, over a minute or at one moment. */
export interface TopClient {
  mac: string;
  name: string;
  vendor: string;
  ip: string;
  /** the UniFi network it is on: "Lookout & Monks", "Default" (the house) ... */
  network: string;
  downMbps: number;
  upMbps: number;
  peakMbps: number;
  /** its share of the internet download at the busiest moment, in % */
  share?: number | null;
  /** what kind of traffic, from UniFi's traffic identification, in MB over about a minute */
  apps?: { cat: string; mb: number }[];
}

/** A moment the internet download through a gateway went over the spike level, and who did it. */
export interface BusyMoment {
  t: number;
  gatewayId: string;
  gatewayName: string;
  totalDown: number;
  clients: TopClient[];
}

export interface PingResult {
  sent: number;
  received: number;
  lossPct: number;
  avg: number | null;
  min: number | null;
  max: number | null;
  /** how it was measured when not ordinary ping: 'tcp:443' = time to open a connection to that port */
  via?: string;
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
  /** running counters from airOS: packets/bytes the AP received from this device (it sent), and sent to it */
  sentPkts?: number | null;
  sentBytes?: number | null;
  recvPkts?: number | null;
}

/** A device ranked by how much it sends, for finding what floods the radios. */
export interface Talker {
  mac: string;
  ip: string;
  /** from UDR3's client list when known */
  name: string;
  vendor: string;
  apId: string;
  apName: string;
  signal: number | null;
  /** packets a second it sent, averaged over the window, and its busiest minute */
  sentPps: number;
  sentPeakPps: number;
  /** packets a second the AP sent to it */
  recvPps: number;
  avgBytes: number | null;
  /** how closely its sending follows the flood level on UDR3 (-1..1), null without enough overlap */
  floodMatch: number | null;
  minutes: number;
  /** plain-English reason when it looks like a flood source */
  suspect: string | null;
}

export interface BlockStep {
  apId: string;
  apName: string;
  state: 'waiting' | 'checking' | 'applying' | 'verifying' | 'done' | 'skipped' | 'failed' | 'undone';
  message: string;
}
export interface BlockJob {
  id: string;
  kind: 'block' | 'unblock';
  mac: string;
  label: string;
  startedAt: number;
  endedAt?: number;
  steps: BlockStep[];
}
export interface BlockedDevice {
  mac: string;
  label: string;
  aps: { apId: string; apName: string }[];
}
export interface AclState {
  job: BlockJob | null;
  jobs: BlockJob[];
  blocked: BlockedDevice[];
  /** APs that couldn't be read, or where blocking isn't possible, and why */
  notes: { apId: string; apName: string; note: string }[];
  refreshedAt: number | null;
  refreshing: boolean;
}

export interface TraceHop {
  id: string;
  name: string;
  /** one entry per second; null = no reply */
  series: (number | null)[];
  median: number | null;
  p95: number | null;
  worst: number | null;
  lossPct: number;
  /** delay this hop adds on top of the one before it, at the median */
  addedMedian: number | null;
  /** spikes that first appear at this hop */
  spikesStartHere: number;
}

export interface TraceResult {
  id: string;
  targetId: string;
  targetName: string;
  reason: 'manual' | 'alert';
  startedAt: number;
  seconds: number;
  hops: TraceHop[];
  spikes: number;
  /** index into hops of the hop where most spikes start, or null */
  culprit: number | null;
  verdict: string;
  /** what else was true during the test */
  context: { backboneMbps: number | null; floodPps: number | null; culpritLink?: string };
  error?: string;
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
  /** present on gateway samples (id `gw:<gateway id>`) */
  gw?: GatewayStats;
  error?: string;
  /** taken while the PC running the app had a poor connection itself, so the ping figures say nothing about the radio */
  pcFault?: boolean;
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

/** A setting the app is able to change on an access point. */
export interface RadioChange {
  txPower?: number;
  frequency?: number;
}

export type SuggestionKind = 'channel' | 'power' | 'noise' | 'restarts' | 'no-ip' | 'weak-clients' | 'backbone-link' | 'slow-hop' | 'login' | 'dhcp-full' | 'backbone-full' | 'flood';

export interface Suggestion {
  /** stable across polls: `<kind>:<deviceId>` */
  id: string;
  kind: SuggestionKind;
  deviceId: string;
  deviceName: string;
  severity: Severity | 'info';
  title: string;
  why: string;
  fix: string;
  /** present when the app can make the change itself */
  change?: RadioChange;
  changeLabel?: string;
}

export interface TrialStats {
  samples: number;
  reachablePct: number;
  pingAvg: number | null;
  lossAvg: number | null;
  clients: number | null;
  noise: number | null;
  /** link quality the AP reports for its devices, averaged over readings that had devices on */
  ccq: number | null;
  txPower: number | null;
  frequency: number | null;
}

export interface TrialCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface ChangeTrial {
  id: string;
  deviceId: string;
  deviceName: string;
  ip: string;
  suggestionId: string;
  title: string;
  change: RadioChange;
  before: RadioChange;
  status: 'checking' | 'applying' | 'testing' | 'kept' | 'reverted' | 'failed';
  startedAt: number;
  trialEndsAt?: number;
  endedAt?: number;
  baseline?: TrialStats;
  result?: TrialStats;
  checks: TrialCheck[];
  message: string;
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
  suggestions: Suggestion[];
  gateways: { cfg: PublicGateway; latest?: Sample; error?: string; errorAt?: number; load?: { peakDown95: number | null; peakUp95: number | null; samples: number } }[];
  backboneMbps: number;
  trial: ChangeTrial | null;
  talkers: Talker[];
  busy: BusyMoment[];
  spikeMbps: number;
  acl: AclState;
  traces: TraceResult[];
  traceRunning: string | null;
  changes: ChangeTrial[];
}

export type PublicGateway = Omit<GatewayCfg, 'passwordEnc'> & { hasPassword: boolean; password?: string };

export interface PublicConfig extends Omit<Config, 'passwordEnc' | 'gateways'> {
  hasPassword: boolean;
  gateways: PublicGateway[];
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
