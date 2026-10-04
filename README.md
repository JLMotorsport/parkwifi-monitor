# Park WiFi Monitor

A Windows tray app that watches the Priory Park wifi system (the airMAX backbone from the house to Lookout, Mast 2 and Monks Meadow, plus the access points) and tells you when something goes wrong.

Every minute it:

- **pings every radio** from your PC (5 × 1400-byte packets), so you can see which hop adds delay or drops packets
- **logs into each radio's airOS page** and reads signal, noise floor, CCQ, airMAX capacity, TX/RX rate, channel, uptime and the list of connected devices
- **keeps the history** (30 days by default) so you can look back at what happened at, say, 15:20 on Friday
- **raises alerts** as Windows notifications: radio not responding, packet loss, slow replies, weak backbone link, noisy AP channel, a radio restarting, a channel change (usually a DFS radar jump on 5 GHz)

Closing the window keeps it running in the tray. The tray icon turns amber or red when there are active alerts.

## Install

1. Open [Releases](https://github.com/JLMotorsport/parkwifi-monitor/releases) and download `ParkWiFiMonitor-Setup-x.y.z.exe` from the latest release.
2. Run it. Windows SmartScreen may warn that the app is unsigned: click **More info → Run anyway**.
3. It installs per-user, starts, and turns on **Start with Windows** (you can turn that off in Settings or the tray menu).

**Updates are automatic.** The app checks GitHub Releases on start and every 6 hours, downloads new versions in the background and installs them the next time it restarts. Settings → App also has **Check now** and **Restart and update**.

## First run

1. **Settings → Radio login:** enter the airOS username and password. The password is encrypted with Windows' own data protection (DPAPI) and stored only on this PC.
2. **Settings → Radios → Discover radios:** scans 192.168.2.1–254 for airOS radios and adds any not already listed. Use **Test** on a row to check the login works.
3. **Settings → Backbone order:** put the backbone radios in order from the house outwards (include the Mast 2 → Monks sender, pp03, once discovery finds it).

The office PC reaches `192.168.2.x` through the static route on UDR2 and the "Office to radios" firewall policy on UDR3. Without those, the radios can't be read.

## Reading the dashboard

- **Ping from this PC** adds up along the chain. The **Added by hop** column is the difference between one radio and the one before, so the hop that adds the delay stands out.
- **Backbone link rows** show what the receiving radio reports about the link: signal, noise, CCQ, airMAX capacity and TX/RX rate. A healthy 20 MHz link reads about 130/130 Mbps, CCQ above 95% and capacity above 90%.
- **Access points:** devices weaker than −75 dBm (configurable) count as *weak*. In practice they can download but barely upload. "No IP" counts devices connected to the AP that never got an address.
- **Raw data** at the bottom of each radio's page shows exactly what airOS returned, for troubleshooting.

## Releasing a new version

You don't need anything installed locally. Any of these builds the Windows installer and publishes a GitHub Release, and installed copies then update themselves:

- **Bump `version` in `package.json` in a commit to `main`.** The Release workflow sees there's no release for that version yet and builds one.
- **Actions → Release → Run workflow**, choosing `patch` / `minor` / `major`. The workflow bumps the version itself.
- Push a tag `vX.Y.Z` that matches `package.json`.

## Running it 24/7 later

The monitoring core doesn't need Electron. On an always-on PC or a Raspberry Pi with Node 20+:

```bash
npm ci && npm run build
node dist/node/main/headless.js --data ./data --port 8787
```

Then turn on **Settings → Access from other devices**. Other machines need the access token shown there. For access away from the park, put that machine on a VPN such as WireGuard on UDR2/UDR3, UniFi Teleport, or Tailscale. Don't port-forward the dashboard to the internet.

## Development

```bash
npm install
npm run dev        # Vite dev server + Electron
npm test           # parser and alert-rule tests
node scripts/mock-radios.mjs   # fake airOS radios on 127.0.0.x:443 (needs scripts/mock-cert/{key,cert}.pem)
```

Layout: `src/core` (airOS client, ping, poller, alert rules, history, HTTP API; no Electron dependency), `src/main` (Electron tray app and headless entry), `src/ui` (React dashboard served by the core's HTTP server).
