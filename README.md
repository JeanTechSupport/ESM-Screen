# ESM lofi relay 🎧

A tiny always-on service that turns the **Lofi Girl YouTube live stream** into a
plain **MP3 stream** the office TVs can play in their existing `<audio>` element.

**Why:** playing the YouTube video on the TVs is heavy (continuous 1080p video
decode on weak TV chips = lag) and shows ads. This relay strips all of that:

- `yt-dlp` resolves Lofi Girl's *current* live audio URL.
- `ffmpeg` drops the video (`-vn`) and transcodes the audio to MP3.
- The same bytes are fanned out to every TV from **one** upstream, served at a
  single stable URL: **`/lofi.mp3`**.
- No video decode on the TV → no lag. No YouTube player → no ads.

When YouTube rotates the URL or Lofi Girl restarts the stream, the upstream dies
and the relay re-resolves + restarts automatically — the TVs keep playing the
same URL and never notice.

## Endpoints

| Path         | What it does                                        |
|--------------|-----------------------------------------------------|
| `/lofi.mp3`  | The MP3 stream (point the TV `<audio>` here)         |
| `/`          | Debug page with an inline player                     |
| `/status`    | JSON: listener count, upstream state, last error     |
| `/healthz`   | Health check (used by Render)                        |

## Config (env vars)

| Var               | Default                                   | Notes                                  |
|-------------------|-------------------------------------------|----------------------------------------|
| `PORT`            | `10000`                                   | Render sets this automatically         |
| `STREAM_URL`      | `https://www.youtube.com/@LofiGirl/live`  | Any YouTube live/video or playlist URL |
| `BITRATE`         | `128k`                                    | MP3 bitrate                            |
| `IDLE_TIMEOUT_MS` | `60000`                                   | Stop the upstream this long after the last TV disconnects |
| `MAX_LISTENERS`   | `50`                                      | Reject new connections past this (flood guard) |
| `MAX_CLIENT_BACKLOG` | `4194304`                              | Drop a client buffering more than this many bytes (slow-consumer guard) |

## Run locally

```bash
# needs ffmpeg + yt-dlp on PATH
node server.js
# open http://localhost:10000
```

Or with Docker (matches production):

```bash
docker build -t esm-lofi-relay .
docker run -p 10000:10000 esm-lofi-relay
```

## Deploy (Render)

Runs on Render's **native Node runtime** (no Docker needed). `ffmpeg` is bundled
via the `ffmpeg-static` npm package and `yt-dlp` is downloaded by the
`postinstall` script, so no system packages are required.

Easiest: **New -> Blueprint** in the Render dashboard, point it at this repo +
branch, and it reads `render.yaml`. Or create a Web Service manually with:

| Setting        | Value                                               |
|----------------|-----------------------------------------------------|
| Runtime        | Node                                                 |
| Build command  | `npm install`                                        |
| Start command  | `npm start`                                          |
| Env var        | `STREAM_URL=https://www.youtube.com/@LofiGirl/live`  |

(If you nest this project inside a subfolder of another repo, set the
service's **Root directory** to that subfolder.)

**Plan:** `render.yaml` uses **Free**, which suits a screen that's only on
during the day — it spins down when no TV is connected (costs nothing overnight)
and cold-starts in ~30-60s on the first morning connection. Free instances have
limited CPU (~0.1 vCPU); a single audio transcode should fit, but if playback
stutters, switch to **Starter** for always-on, full-CPU streaming.

For a Docker-based deploy instead (e.g. self-hosting), use the included
`Dockerfile` — the server falls back to `ffmpeg`/`yt-dlp` on `PATH`.

## YouTube bot-check (cookies)

From a cloud/datacenter IP, YouTube often refuses `yt-dlp` with *"Sign in to
confirm you're not a bot."* The fix is to authenticate with cookies:

1. With a **throwaway** Google account (not a personal one — datacenter scraping
   can get it flagged), open an **Incognito** window and log into YouTube.
2. Export cookies for `youtube.com` in **Netscape format** (e.g. the
   "Get cookies.txt LOCALLY" browser extension), then **close the Incognito
   window without logging out** so the session stays valid.
3. On Render: service → **Environment → Secret Files → Add Secret File**,
   filename **`cookies.txt`**, paste the exported contents. It mounts at
   `/etc/secrets/cookies.txt`, which the relay picks up automatically (the
   startup log then shows `cookies: loaded`). Never commit cookies to the repo.

Cookies expire and can be invalidated over time; re-export and update the secret
file if the stream starts failing again. Set `YTDLP_COOKIES` to override the path.

Cookies alone aren't enough from a datacenter IP anymore — YouTube also wants a
**proof-of-origin (PO) token**. The Docker image bundles the
[`bgutil-ytdlp-pot-provider`](https://github.com/Brainicism/bgutil-ytdlp-pot-provider)
server (a small Node HTTP service on `127.0.0.1:4416`, started alongside the
relay by `start.sh`) plus its yt-dlp plugin, so yt-dlp mints PO tokens locally
and auto-discovers the provider — no config needed. The image also installs
**Deno**: yt-dlp 2026+ needs a JS runtime for YouTube's player JS challenge, or
extraction falls back to clients that only return `LOGIN_REQUIRED`. This is why
the relay is deployed via the Dockerfile rather than the plain Node runtime. Heads-up: the
provider adds memory pressure, so if the free instance OOM-restarts, move to a
larger Render plan. The `YTDLP_EXTRACTOR_ARGS` env var is available to switch
player clients (e.g. `youtube:player_client=tv,web_safari`) without a redeploy.

## Caveats

- This relies on `yt-dlp`, which plays cat-and-mouse with YouTube and breaks
  from time to time — **redeploy to pull the latest `yt-dlp`** if the stream
  stops. `/status` shows the last error.
- Consumer YouTube is licensed for personal use; check music-licensing
  expectations before using in a customer-facing space.
