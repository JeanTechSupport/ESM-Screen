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

## Caveats

- This relies on `yt-dlp`, which plays cat-and-mouse with YouTube and breaks
  from time to time — **redeploy to pull the latest `yt-dlp`** if the stream
  stops. `/status` shows the last error.
- Consumer YouTube is licensed for personal use; check music-licensing
  expectations before using in a customer-facing space.
