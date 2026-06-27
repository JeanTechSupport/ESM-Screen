# ESM lofi relay 🎧

A tiny always-on service that streams **Lofi Girl's catalogue (via SoundCloud)**
as a plain **MP3** the office TVs play in their existing `<audio>` element.

**Why:** the TVs just need background lofi with no video decode (lag on weak TV
chips) and no ads. This relay:

- `yt-dlp` flat-lists the SoundCloud source into track permalinks (shuffled).
- For each track it resolves a fresh media URL, and `ffmpeg` transcodes the
  audio to MP3 (`-vn`, no video).
- The same bytes are fanned out to every TV from **one** upstream, at a single
  stable URL: **`/lofi.mp3`**. When a track ends it segues to the next and loops
  the catalogue forever.

### Why SoundCloud and not the YouTube live feed

YouTube bot-walls datacenter IPs (like Render's) at the *login* layer — every
player client returns `LOGIN_REQUIRED`, and the only thing that gets past it,
account cookies, gets invalidated by Google within hours. We proved this end to
end (PO-token provider + Deno JS runtime + EJS solver all working, still walled).
SoundCloud hosts the same Lofi Girl label catalogue and resolves cleanly from a
server with **plain yt-dlp** — no cookies, tokens, JS runtime, or secrets. See
`HANDOFF.md` for the full investigation.

## Endpoints

| Path         | What it does                                              |
|--------------|----------------------------------------------------------|
| `/lofi.mp3`  | The MP3 stream (point the TV `<audio>` here)              |
| `/`          | Debug page with an inline player                          |
| `/status`    | JSON: listeners, upstream state, track count/index, error |
| `/diag`      | Verbose yt-dlp probe (`?url=` any source, `?list` to list) |
| `/healthz`   | Health check                                             |

## Config (env vars)

| Var               | Default                          | Notes                                   |
|-------------------|----------------------------------|-----------------------------------------|
| `PORT`            | `10000`                          | Render sets this automatically          |
| `STREAM_URL`      | `https://soundcloud.com/lofi_girl` | Any SoundCloud user/playlist/track URL |
| `BITRATE`         | `128k`                           | MP3 bitrate                             |
| `SHUFFLE`         | `1`                              | Shuffle the catalogue; `0` to play in order |
| `MAX_TRACKS`      | `300`                            | Cap how many tracks are listed          |
| `RELIST_MS`       | `21600000` (6h)                  | How often the track list is refreshed   |
| `IDLE_TIMEOUT_MS` | `60000`                          | Stop the upstream this long after the last TV disconnects |
| `MAX_LISTENERS`   | `50`                             | Reject new connections past this        |
| `MAX_CLIENT_BACKLOG` | `4194304`                     | Drop a client buffering more than this many bytes |

## Run locally

```bash
# needs ffmpeg + yt-dlp on PATH (pip install "yt-dlp[default]")
node server.js
# open http://localhost:10000
```

Or with Docker (matches production):

```bash
docker build -t esm-lofi-relay .
docker run -p 10000:10000 esm-lofi-relay
```

## Deploy (Render)

Built from the `Dockerfile` (runtime: **docker**) — ffmpeg + yt-dlp, nothing
else. Easiest: **New → Blueprint** in the Render dashboard, point it at this repo
+ branch, and it reads `render.yaml`. Or create a Web Service manually with
runtime **Docker** and env `STREAM_URL=https://soundcloud.com/lofi_girl`.

(If you nest this project inside a subfolder of another repo, set the service's
**Root directory** to that subfolder.)

**Plan:** `render.yaml` uses **Free**, which suits a screen that's only on during
the day — it spins down when no TV is connected (nothing billed overnight) and
cold-starts in ~30-60s on the first morning connection. A single audio transcode
fits comfortably; if playback ever stutters, bump to **Starter**.

## Caveats

- This relies on `yt-dlp`, which can break when SoundCloud changes — **redeploy
  to pull the latest `yt-dlp`** if playback stops. `/status` shows the last error
  and `/diag` gives verbose output.
- It plays Lofi Girl's *track catalogue on a loop*, not the literal 24/7 YouTube
  "radio" feed — same music from the same label, just a different transport.
- Check music-licensing expectations before using in a customer-facing space.
