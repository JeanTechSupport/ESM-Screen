# Lofi relay — handoff / status doc

> Living doc for whoever picks this up next. Goal: play the **Lofi Girl YouTube
> live** stream as background audio on the office TVs, reliably, from a cloud
> server. We're deep in beating YouTube's datacenter-IP bot detection.
> Last updated mid-session after adding diagnostics (not yet deployed/tested).

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

- **JeanCamposLabs `main` = `ef874f8`** (has diagnostics).
- **Render is running the PREVIOUS commit** (`c7843a9` = PO provider, **no
  diagnostics**). The user has **not re-synced `ef874f8` yet.**
- Last observed `/status`: `upstream: stopped`, and after pressing play,
  `lastError: ... Sign in to confirm you're not a bot ... Use --cookies`.

### → IMMEDIATE NEXT STEP
Have the user run the re-sync ritual (§2) to deploy `ef874f8` (fast build — only
`server.js` changed, Docker layers are cached), then collect:

1. **`/status`** (JSON) — note `ytdlpVersion`, `cookies`, **`potProvider`**
   (is the token server reachable from yt-dlp?), `lastArgs`, `lastStderrTail`.
2. **`/diag`** (full text, ~10–30s) — shows in verbose yt-dlp output whether the
   **bgutil plugin loaded**, which **player clients** were tried, and whether a
   **PO token was fetched**.
3. **Client scan** — open each and read the `# exit:` / `# url:` header lines;
   we want one that says **`exit: 0`** with a real URL:
   - `/diag?client=default`
   - `/diag?client=tv`
   - `/diag?client=mweb`
   - `/diag?client=tv,web_safari,mweb,web`

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
