# Lofi relay — handoff / status doc

> Living doc for whoever picks this up next. Goal: play Lofi Girl as background
> audio on the office TVs, reliably, from a cloud server.

---

## 0. ✅ RESOLUTION — switched to SoundCloud

**YouTube from a datacenter IP is a dead end** (proven exhaustively below: even
with the PO-token provider + Deno + EJS solver all working, every client returns
`LOGIN_REQUIRED`, and the only thing that passes — account cookies — Google
invalidates within hours). 

**The fix: stream Lofi Girl's catalogue from SoundCloud instead.** SoundCloud
resolves cleanly from Render with plain yt-dlp (verified: `/diag?url=https://soundcloud.com/lofi_girl`
→ `exit: 0` with a media URL — no cookies/tokens/JS runtime). The relay was
rewritten to flat-list the SoundCloud source into track permalinks, shuffle, and
resolve + transcode them on a loop. The whole YouTube anti-bot stack (bgutil
provider, Deno, cookies, PO tokens, `start.sh`, tini) was **removed** — smaller
image, no OOM risk, no secrets.

Sections 1–9 below are the historical YouTube investigation, kept for context.
The current design is documented in `README.md`. Key env: `STREAM_URL`
(SoundCloud URL), `SHUFFLE`, `MAX_TRACKS`, `RELIST_MS`. Debug via `/diag`
(`?url=` any source, `?list` to flat-list) and `/status` (track count/index).

---

## 1. What this is

ESM-Screen is the office wall display (a GitHub Pages site on `main`). The TVs
play a stable MP3 in an `<audio>` element. YouTube can't be played directly
(ads, video, player restrictions), so `radio-relay/` is a small relay:

- **yt-dlp** resolves the current Lofi Girl live **audio** URL,
- **ffmpeg** transcodes it to MP3,
- the relay fans the same bytes out to every TV at a stable URL **`/lofi.mp3`**.

When YouTube rotates the URL / restarts the stream, the upstream dies and we
re-resolve; the TVs keep hitting `/lofi.mp3` and never notice.

---

## 2. Deploy topology (READ THIS — it's the confusing part)

There are **two GitHub repos** involved:

| Repo | Role | Can the agent push? |
|------|------|---------------------|
| **JeanCamposLabs/ESM-Screen** | Source of truth. Relay lives in `radio-relay/`. | ✅ yes (agent pushes here, branch `main`) |
| **JeanTechSupport/ESM-Screen** | What Render actually deploys. Relay files are at the repo **root** (not under `radio-relay/`). | ❌ no — out of scope. **The user** re-syncs manually. |

**Because they're separate repos, commit hashes differ.** e.g. the PO-token
commit is `1054565` in JeanCamposLabs but deployed as `c7843a9` in
JeanTechSupport. Don't be confused by mismatched hashes.

### The user's re-sync ritual (they run this on their machine)
```bash
rm -rf ~/esm-src
git clone https://github.com/JeanCamposLabs/ESM-Screen.git ~/esm-src
cp -R ~/esm-src/radio-relay/. ~/esm-lofi-relay/   # ~/esm-lofi-relay = their JeanTechSupport clone
cd ~/esm-lofi-relay && git add . && git commit -m "..." && git push origin main
```
Pushing to JeanTechSupport auto-deploys on Render.

### Render service
- Name: **esm-lofi-relay** · Service ID `srv-d8t8l9pkh4rs73bp0fdg`
- Runtime **Docker**, **Free** plan, region **frankfurt**, autoDeploy on commit
- Public URL: **https://esm-lofi-relay.onrender.com**
- **Render MCP**: available, but **no workspace selected** and `list_workspaces`
  returned **HTTP 400** this session — couldn't use it. `select_workspace`
  needs explicit user confirmation. So **env-var changes are done by the user in
  the Render dashboard** for now (or fix the MCP first).

### Secrets
- **YouTube cookies** = a Render **Secret File** named `cookies.txt`
  (mounts at `/etc/secrets/cookies.txt`). Throwaway Google account, exported with
  the "Get cookies.txt LOCALLY" extension (Netscape format). Relay copies it to
  a tmp path and passes `--cookies`. Startup log shows `cookies: loaded`.
  **Never committed** (gitignored). Re-export if it expires.

---

## 3. The story so far (what we tried, in order)

1. Bare yt-dlp from Render → `Sign in to confirm you're not a bot`.
2. **Added cookies** (Secret File) → got past the bot check, but then
   `No video formats found!` — caused by a **stale yt-dlp** frozen in a cached
   Docker layer.
3. **Dockerfile cache-bust** (`ADD` of yt-dlp's latest-release metadata) +
   "Clear build cache & deploy" → fresh yt-dlp (2026.6.9)… but the error flipped
   **back to the bot check even with cookies**. Modern yt-dlp from a datacenter
   IP needs a **proof-of-origin (PO) token**.
4. User chose **"keep Lofi Girl, robustly"** → **bundled the bgutil PO-token
   provider** (commit `1054565` / deployed `c7843a9`):
   - Dockerfile is now `FROM brainicism/bgutil-ytdlp-pot-provider:latest` (so the
     provider + its native deps like `canvas` are prebuilt), then adds ffmpeg +
     **pip** yt-dlp + the **pip** bgutil plugin + the relay.
   - `start.sh` runs the provider (Node HTTP server, `127.0.0.1:4416`) in the
     background, then `exec`s the relay, all under `tini`.
   - **Build succeeded. Provider started** (`Started POT server (v1.3.1) on
     [::]:4416`), `cookies: loaded`, yt-dlp `2026.6.9`, plugin `1.3.1`.
   - ❌ **Still bot-walls.** So the PO token isn't actually being applied —
     plugin not used, token-gen failing, or yt-dlp picking a client that
     ignores the token.
5. **Added diagnostics** (commit `ef874f8`, **NOT YET DEPLOYED**): `/diag`
   verbose probe + richer `/status`. ← we stopped here (user out of tokens).

---

## 4. ⚠️ EXACT CURRENT STATE

**Root cause FOUND** via `/diag` (diagnostics commit `ef874f8` got deployed and
tested). The blocker was **not the cookies** — yt-dlp 2026 needs a **JavaScript
runtime** for YouTube's player JS challenge. Verbose output showed:
```
WARNING: [youtube] No supported JavaScript runtime could be found...
[jsc] JS Challenge Providers: deno (unavailable), node (unavailable), ...
[youtube] Downloading android vr player API JSON
[youtube] android_vr ... playability status: LOGIN_REQUIRED
```
With no JS runtime, yt-dlp skips the web/tv clients (the ones that use our PO
token + cookies) and falls back to the JS-free `android_vr` client → bot wall.
The PO-token provider itself is healthy (`bgutil:http-1.3.1` loaded; `/status`
showed `potProvider: reachable (HTTP 200) ... version 1.3.1`).

### Progress chain (each step deployed & verified via /diag)
1. **Deno installed** (`COPY --from=denoland/deno:bin`) → JS runtime active
   (`JS runtimes: deno-2.9.0`). yt-dlp then tried web_safari, but → `LOGIN_REQUIRED`.
2. **Cookies refreshed** (new Secret File) → `Found YouTube account cookies`, and
   the **PO token now works**: `Generating/Retrieved a gvs PO Token for web_safari
   client via bgutil HTTP server`. Auth + bot wall solved. New error:
   `No video formats found`.
3. **Final blocker:** the EJS **challenge solver script** is missing —
   `[jsc:deno] challenge solving failed` + `Remote components ... were skipped`.
   yt-dlp won't download the solver unless allowed.

**Fix applied (latest commit, pushed to JeanCamposLabs `main`):** add
**`--remote-components ejs:github`** to the yt-dlp calls (server.js), via a
`YTDLP_REMOTE_COMPONENTS` env lever (default `ejs:github`) + `/diag?remote=`
override + `remoteComponents` in `/status`. This is a server.js-only change
(fast rebuild). yt-dlp downloads the solver from the yt-dlp org at first resolve
and caches it.

### → IMMEDIATE NEXT STEP
1. User re-syncs (ritual §2) + deploy (fast — only server.js changed).
2. Check **`/diag`** → expect `challenge solving` to succeed and **`# exit: 0`**
   with a URL. Then `/status` → `upstream: running` and the wall plays. 🎧
3. If `/diag` shows formats but the audio still won't play, it's a stream/ffmpeg
   issue, not extraction — check ffmpeg logs.
4. If remote-components download is blocked/undesirable, the robust alternative is
   to pre-bundle the EJS solver into the image at build (see yt-dlp EJS wiki) and
   set `YTDLP_REMOTE_COMPONENTS=""`.

---

## 5. Decision tree for the diagnostics

- **A client returns `exit: 0` + a URL** → set env var
  **`YTDLP_EXTRACTOR_ARGS=youtube:player_client=<that>`** in Render dashboard
  (Environment → Environment Variables). Instant restart, no rebuild. Done. The
  relay already reads this env var (`server.js`).
- **`/diag` shows the plugin did NOT load** (no PO-token/provider lines) → fix
  plugin discovery. Confirm `yt-dlp` on PATH is the **pip** one and the pip
  `bgutil-ytdlp-pot-provider` is in the same env. As a manual override, the
  plugin can be pointed at the provider explicitly via extractor-args:
  `youtubepot-bgutilhttp:base_url=http://127.0.0.1:4416` (combine with the
  player_client arg, separated per yt-dlp's syntax).
- **`potProvider` is `unreachable`** → the provider isn't up / wrong port. Check
  Render logs for the `Started POT server` line and `start.sh` output. Port is
  `POT_PORT` env (default 4416).
- **Provider reachable + plugin loaded but tokens rejected** → likely needs a
  specific client, or the cookies' account/IP is flagged. Try the client scan;
  consider re-exporting cookies from a fresh throwaway account; check provider
  logs for token-generation errors (it may need outbound network to fetch the
  BotGuard VM).

---

## 6. Fallback (offered, currently declined)

If the YouTube/PO-token route stays intractable, the bulletproof option is a
**direct lofi stream** (no YouTube, no yt-dlp, no cookies). Example direct MP3:
`https://coderadio-admin-v2.freecodecamp.org/listen/coderadio/radio.mp3`
(freeCodeCamp Code Radio — jazzy lofi). A direct MP3 can even be played by the
TV's `<audio>` element directly, retiring the relay entirely. The user wants the
*actual* Lofi Girl channel, so keep this in the back pocket only.

---

## 7. File map (`radio-relay/`)

- **`server.js`** — the relay. `resolveAudioUrl()` runs `yt-dlp -g`; ffmpeg
  transcodes; `/lofi.mp3` fanout with prebuffer + idle-stop + backoff.
  Endpoints: `/`, `/lofi.mp3`, `/status`, **`/diag`**, `/healthz`.
  Env knobs: `STREAM_URL`, `BITRATE`, `YTDLP_COOKIES`, **`YTDLP_EXTRACTOR_ARGS`**,
  `POT_PORT`, `YTDLP_PATH`, `FFMPEG_PATH`, plus listener/idle caps.
- **`Dockerfile`** — `FROM brainicism/bgutil-ytdlp-pot-provider:latest` + ffmpeg
  + pip yt-dlp + pip bgutil plugin + tini + start.sh. `ADD` of yt-dlp's
  latest-release JSON busts the pip layer on new releases.
- **`start.sh`** — `( cd /app && node build/main.js ) &` then
  `exec node /relay/server.js`.
- **`render.yaml`** — Blueprint: runtime docker, free, frankfurt, `STREAM_URL`.
  (The live service may have been created manually; this documents intent.)
- **`package.json`** — dep `ffmpeg-static`; `postinstall` runs
  `scripts/fetch-ytdlp.js`. **Only relevant to the non-Docker Node runtime** —
  Docker doesn't run `npm install`, it uses apt ffmpeg + pip yt-dlp.
- **`scripts/fetch-ytdlp.js`** — downloads the yt-dlp binary (non-Docker path).
- **`README.md`** — cookies + PO-token setup notes.
- **`.gitignore`** — `node_modules/`, `bin/`, `*.log`, `cookies.txt`,
  `yt-cookies.txt`.

### Endpoints quick ref
| Path | Purpose |
|------|---------|
| `/lofi.mp3` | the stream the TVs consume |
| `/status` | JSON: upstream state + diagnostics |
| `/diag[?client=…\|?args=…]` | verbose yt-dlp probe (no redeploy to test clients) |
| `/healthz` | `ok` |

---

## 8. Caveats / gotchas

- **RAM:** Free Render = 512 MB. The provider (canvas/jsdom/BotGuard) is heavy;
  watch for OOM-restarts in logs → bump the plan if so.
- **Cookies expire** → re-export + update the Secret File.
- **Docker layer cache** can freeze yt-dlp/provider; the `ADD` cache-bust helps,
  "Clear build cache & deploy" forces a clean rebuild.
- **Pages site unaffected:** `radio-relay/` is not published by GitHub Pages, so
  pushing relay changes to `main` doesn't touch the live ESM-Screen site.
- Agent model identity must not appear in commits/PRs/code (chat only).

---

## 9. Commit trail (JeanCamposLabs/ESM-Screen `main`)
```
ef874f8  add /diag verbose probe and richer /status diagnostics   <-- HEAD, not yet deployed
1054565  bundle bgutil PO-token provider                          <-- deployed as c7843a9
985a0f6  keep yt-dlp fresh in Docker + tunable extractor args
102017d  support YouTube cookies
bfc9e36  add Lofi Girl station via relay; make it the default house station
```
