# Ohm

A macOS Dynamic Island-style Spotify controller for Windows. A black pill floats
at the top-center of the screen showing the current track; hovering it springs
open an expanded panel with album art, a scrubbable timeline, and transport
controls (shuffle / previous / play-pause / next / repeat). Hovering the little
bar at the bottom drops a detached queue card; middle-click the island (or use
the right-click menu) to minimize the whole thing to a thin line — click the
line to bring it back.

To change the app icon, drop a square PNG (256px or larger) named `icon.png`
into `build/` — it becomes the installer + app icon on the next build.

## How it works

- **Electron shell** (`main.js`, `renderer/`) — frameless transparent
  always-on-top window. The window is click-through except when the cursor is
  over the island itself (the main process polls the cursor at ~8Hz against
  bounds reported by the renderer, because forwarded mouse events through a
  click-through window are unreliable on Windows).
- **`sidecar/SmtcBridge.exe`** (C#, .NET 8) — reads the Windows
  GlobalSystemMediaTransportControlsSession (SMTC) for the Spotify session:
  track metadata, album art, timeline, shuffle/repeat. Event-driven, idles at
  ~0% CPU. Speaks JSON lines on stdout, accepts commands
  (`playpause`, `next`, `prev`, `seek <ms>`, `shuffle`, `repeat`) on stdin.
  No Spotify API keys needed — it controls the local Spotify client.

## Run

```
npm install
npm run build:sidecar   # needs .NET 8 SDK, one time
npm start
```

## Queue drop-down (one-time setup)

The little bar at the bottom of the expanded island drops down the current
playlist/album so you can click any song to jump to it. Windows' media session
has no queue data, so this uses the Spotify Web API and needs a client ID once:

1. Go to https://developer.spotify.com/dashboard → Create app.
2. Name it anything; set the Redirect URI to `http://127.0.0.1:8898/callback`
   (Web API, no secret needed — this is a PKCE public client).
3. Copy the Client ID into `spotify-config.json` (`"clientId": "..."`).
4. Right-click the island → "Connect Spotify account…" and approve in the browser.

While the Spotify app is in Development Mode, each person who uses the queue
feature must be added under User Management in the dashboard (max 25).
Jumping to a song uses the Web API (Premium); free accounts fall back to
skip-forward when the target is later in the list.

## Auto-update / publishing

`npm run push` bumps the patch version, rebuilds the sidecar, commits and
pushes source, builds the installer, and publishes it to GitHub Releases
(`yt2corgi/spotify-island`). Installed copies check on launch and every 3
hours, then update silently. `npm run build:installer` builds locally without
publishing.

## Behavior

- Hover the pill → expands (Apple-style spring). Move away → collapses.
- Right-click the island → menu: Open Spotify, Start with Windows, Quit.
- Auto-starts at login by default (registry Run entry `SpotifyIsland`,
  created on first run; toggle in the right-click menu).
- Runs at above-normal process priority; sidecar auto-restarts if it dies.
- If nothing is playing, shows an idle pill; expanding offers "Open Spotify".

## Dev flags

- `electron . --demo` — fake track data (collapsed)
- `electron . --demo-expanded` — fake data, forced expanded (for screenshots)
- `electron . --debug-hover` — logs hover hit-testing to `%TEMP%\island-hover-debug.log`

Note when launching from a dev shell: unset `ELECTRON_RUN_AS_NODE` first.
