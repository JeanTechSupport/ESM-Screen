'use strict';
/**
 * ESM-Screen lofi relay
 * --------------------------------------------------------------------------
 * Turns the Lofi Girl YouTube *live* stream into a plain, always-on MP3 feed
 * that the office TVs play in their existing <audio> element — no video decode
 * (so no lag on weak TV chips) and no YouTube player (so no ads).
 *
 * One upstream is shared by every TV: yt-dlp resolves the current live audio
 * URL, ffmpeg transcodes it to MP3, and we fan the same bytes out to all
 * connected listeners. When YouTube rotates the URL or Lofi Girl restarts the
 * stream the upstream simply dies; we re-resolve and restart, while the TVs
 * keep playing the one stable URL (/lofi.mp3) and never notice.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Resolve the ffmpeg / yt-dlp binaries. On Render's native Node runtime these
// come from npm (ffmpeg-static) and the postinstall download (./bin/yt-dlp);
// in Docker / locally they're system packages on PATH. Env vars override both.
function tryRequire(name) { try { return require(name); } catch { return null; } }
const FFMPEG = process.env.FFMPEG_PATH || tryRequire('ffmpeg-static') || 'ffmpeg';
const LOCAL_YTDLP = path.join(__dirname, 'bin', 'yt-dlp');
const YTDLP = process.env.YTDLP_PATH
  || (fs.existsSync(LOCAL_YTDLP) ? LOCAL_YTDLP : 'yt-dlp');

// Optional YouTube cookies to get past datacenter-IP bot checks ("Sign in to
// confirm you're not a bot"). On Render, upload the Netscape-format cookies as a
// Secret File named cookies.txt — it mounts read-only at /etc/secrets/cookies.txt.
// We copy it to a writable temp path so yt-dlp can refresh the jar in place.
// No file present -> we just run without cookies.
const COOKIES_SRC = process.env.YTDLP_COOKIES || '/etc/secrets/cookies.txt';
let COOKIES = null;
try {
  if (fs.existsSync(COOKIES_SRC)) {
    COOKIES = path.join(os.tmpdir(), 'yt-cookies.txt');
    fs.copyFileSync(COOKIES_SRC, COOKIES);
  }
} catch (e) { console.error('cookies setup failed:', e.message); }

// Optional yt-dlp extractor args, e.g. "youtube:player_client=tv,web_safari".
// Lets us work around an occasional "No video formats found" on the live stream
// by switching player clients without a redeploy — set YTDLP_EXTRACTOR_ARGS in
// the Render environment. Empty -> yt-dlp's defaults.
const EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || '';

// yt-dlp 2026+ needs a JS runtime (deno/node/...) for YouTube's player JS
// challenge; the Docker image installs deno, which yt-dlp uses by default. Set
// YTDLP_JS_RUNTIMES to force one, e.g. "node:/usr/local/bin/node" or "deno"
// (empty string -> let yt-dlp pick its default).
const JS_RUNTIMES = 'YTDLP_JS_RUNTIMES' in process.env ? process.env.YTDLP_JS_RUNTIMES : '';

// Having a JS runtime isn't enough: yt-dlp also needs the EJS "challenge solver"
// script, which it won't fetch unless remote components are enabled. ejs:github
// pulls it from the yt-dlp org (the recommended source). Without it, challenge
// solving fails and you get "No video formats found". Override/disable via
// YTDLP_REMOTE_COMPONENTS.
const REMOTE_COMPONENTS = 'YTDLP_REMOTE_COMPONENTS' in process.env
  ? process.env.YTDLP_REMOTE_COMPONENTS
  : 'ejs:github';

const PORT = parseInt(process.env.PORT, 10) || 10000;
const STREAM_URL = process.env.STREAM_URL || 'https://www.youtube.com/@LofiGirl/live';
const BITRATE = process.env.BITRATE || '128k';
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS, 10) || 60000; // stop upstream after last TV leaves
const PREBUFFER_BYTES = parseInt(process.env.PREBUFFER_BYTES, 10) || 256 * 1024; // kickstart playback fast
// Caps so a flood of connections or a stalled client can't exhaust the host.
const MAX_LISTENERS = parseInt(process.env.MAX_LISTENERS, 10) || 50;             // reject new connections past this
const MAX_CLIENT_BACKLOG = parseInt(process.env.MAX_CLIENT_BACKLOG, 10) || 4 * 1024 * 1024; // drop a TV buffering > this

/** @type {Set<import('http').ServerResponse>} */
const listeners = new Set();
let proc = null;          // current { ffmpeg } pipeline, or null
let starting = false;     // guard against concurrent starts
let restartTimer = null;
let idleTimer = null;
let backoffMs = 1000;
let lastError = null;
let lastStderr = null;        // full stderr from the last failed resolve (diagnostics)
let lastResolveArgs = null;   // the exact yt-dlp command of the last resolve (diagnostics)
let ytdlpVersion = 'unknown';
const POT_PORT = parseInt(process.env.POT_PORT, 10) || 4416;

// Small ring buffer of the most recent MP3 bytes so a newly-connected TV starts
// playing immediately instead of waiting for the next ffmpeg chunk.
const prebuffer = [];
let prebufferBytes = 0;
function remember(chunk) {
  prebuffer.push(chunk);
  prebufferBytes += chunk.length;
  while (prebufferBytes > PREBUFFER_BYTES && prebuffer.length > 1) {
    prebufferBytes -= prebuffer.shift().length;
  }
}
function clearPrebuffer() { prebuffer.length = 0; prebufferBytes = 0; }

// Single, idempotent cleanup path for a departing listener — called from the
// request close/error handlers and when we drop a slow client. Schedules the
// idle shutdown once the last TV is gone.
function removeListener(res) {
  if (!listeners.delete(res)) return;
  log('listener -1 ->', listeners.size);
  if (listeners.size === 0) scheduleIdleStop();
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

// Run a command to completion, capturing stdout/stderr (used by /diag and the
// startup version probe). Never rejects; resolves {code,out,err}.
function runCapture(bin, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let out = '', err = '', child;
    try { child = spawn(bin, args); }
    catch (e) { return resolve({ code: -1, out, err: String(e) }); }
    const t = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: err + String(e) }); });
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }); });
  });
}

// Is the local PO-token provider answering? Probed for /status and /diag so we
// can tell "provider down" apart from "provider up but token rejected".
function probeProvider(timeoutMs = 800) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: POT_PORT, path: '/ping', timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(`reachable (HTTP ${res.statusCode})${body ? ' ' + body.slice(0, 160).replace(/\s+/g, ' ').trim() : ''}`));
    });
    req.on('timeout', () => { req.destroy(); resolve('unreachable (timeout)'); });
    req.on('error', (e) => resolve(`unreachable (${e.code || e.message})`));
  });
}

// Resolve the current live audio URL with yt-dlp (-g prints the direct media URL).
function resolveAudioUrl() {
  return new Promise((resolve, reject) => {
    const args = [
      '-g',                    // print resolved media URL(s) instead of downloading
      '-f', 'bestaudio/best',  // prefer audio-only; fall back to best (we drop video below)
      '--no-warnings',
      '--no-playlist',
    ];
    if (JS_RUNTIMES) args.push('--js-runtimes', JS_RUNTIMES);
    if (REMOTE_COMPONENTS) args.push('--remote-components', REMOTE_COMPONENTS);
    if (COOKIES) args.push('--cookies', COOKIES);
    if (EXTRACTOR_ARGS) args.push('--extractor-args', EXTRACTOR_ARGS);
    args.push(STREAM_URL);
    lastResolveArgs = [YTDLP, ...args].join(' ');
    const yt = spawn(YTDLP, args);
    let out = '', err = '';
    yt.stdout.on('data', (d) => (out += d));
    yt.stderr.on('data', (d) => (err += d));
    yt.on('error', reject);
    yt.on('close', (code) => {
      const url = out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
      if (code === 0 && url) { lastStderr = err || null; resolve(url); }
      else { lastStderr = err; reject(new Error(`yt-dlp exited ${code}: ${err.trim() || 'no URL returned'}`)); }
    });
  });
}

async function startPipeline() {
  if (proc || starting) return;
  starting = true;
  try {
    log('resolving live audio URL from', STREAM_URL);
    const url = await resolveAudioUrl();
    log('resolved; starting ffmpeg transcode ->', BITRATE, 'mp3');
    const ffmpeg = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      // ride out brief network hiccups in the live feed instead of dying
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', url,
      '-vn',                              // drop video — TVs only ever get audio
      '-acodec', 'libmp3lame', '-b:a', BITRATE,
      '-f', 'mp3', 'pipe:1',
    ]);
    proc = { ffmpeg };
    ffmpeg.stdout.on('data', (chunk) => {
      backoffMs = 1000;                   // healthy data flowing -> reset backoff
      remember(chunk);
      for (const res of listeners) {
        try {
          res.write(chunk);
          // A TV that can't keep up makes Node buffer unbounded RAM — cut it loose.
          if (res.writableLength > MAX_CLIENT_BACKLOG) {
            log('dropping slow listener (backlog over limit)');
            res.destroy();
            removeListener(res);
          }
        } catch { removeListener(res); }
      }
    });
    ffmpeg.stderr.on('data', (d) => { lastError = d.toString().trim(); });
    const onExit = (why) => {
      if (!proc) return;
      proc = null;
      clearPrebuffer();
      log('upstream ended:', why, '— listeners:', listeners.size);
      if (listeners.size > 0) scheduleRestart();
    };
    ffmpeg.on('error', (e) => { lastError = String(e); onExit('ffmpeg error'); });
    ffmpeg.on('close', (code) => onExit(`ffmpeg closed ${code}`));
  } catch (e) {
    lastError = String((e && e.message) || e);
    log('start failed:', lastError);
    if (listeners.size > 0) scheduleRestart();
  } finally {
    starting = false;
  }
}

function scheduleRestart() {
  if (restartTimer || proc) return;
  const wait = backoffMs;
  backoffMs = Math.min(backoffMs * 2, 30000); // exponential backoff, capped at 30s
  log(`restarting upstream in ${wait}ms`);
  restartTimer = setTimeout(() => { restartTimer = null; startPipeline(); }, wait);
}

function stopPipeline() {
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (proc) {
    log('stopping upstream (no listeners)');
    const p = proc; proc = null;
    try { p.ffmpeg.kill('SIGKILL'); } catch { /* already gone */ }
    clearPrebuffer();
  }
}

function scheduleIdleStop() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (listeners.size === 0) stopPipeline();
  }, IDLE_TIMEOUT_MS);
}

const server = http.createServer(async (req, res) => {
  const path = (req.url || '/').split('?')[0];

  if (path === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (path === '/status') {
    const potProvider = await probeProvider();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      source: STREAM_URL,
      listeners: listeners.size,
      upstream: proc ? 'running' : 'stopped',
      lastError,
      ytdlpVersion,
      cookies: !!COOKIES,
      extractorArgs: EXTRACTOR_ARGS || null,
      jsRuntimes: JS_RUNTIMES || '(yt-dlp default)',
      remoteComponents: REMOTE_COMPONENTS || '(none)',
      potProvider,
      lastArgs: lastResolveArgs,
      lastStderrTail: lastStderr ? lastStderr.slice(-2500) : null,
    }, null, 2));
  }

  // On-demand verbose probe: runs yt-dlp -v against the stream and returns the
  // full output, so we can see whether the PO-token plugin loaded, which player
  // clients were tried, and whether a token was fetched. Optional overrides
  // (no redeploy needed to experiment):
  //   /diag?client=tv,web_safari  -> --extractor-args youtube:player_client=...
  //   /diag?args=<raw>            -> --extractor-args <raw>
  // Whichever combo prints "exit: 0" with a url is what to bake into the
  // YTDLP_EXTRACTOR_ARGS env var.
  if (path === '/diag') {
    const q = new URL(req.url, 'http://x').searchParams;
    const raw = q.get('args');
    const client = q.get('client');
    const extractor = raw || (client ? `youtube:player_client=${client}` : EXTRACTOR_ARGS);
    const jsr = q.has('jsruntimes') ? q.get('jsruntimes') : JS_RUNTIMES;
    const remote = q.has('remote') ? q.get('remote') : REMOTE_COMPONENTS;
    const args = ['-v', '-g', '-f', 'bestaudio/best', '--no-playlist'];
    if (jsr) args.push('--js-runtimes', jsr);
    if (remote) args.push('--remote-components', remote);
    if (COOKIES) args.push('--cookies', COOKIES);
    if (extractor) args.push('--extractor-args', extractor);
    args.push(STREAM_URL);
    const provider = await probeProvider();
    const r = await runCapture(YTDLP, args, 120000);
    const url = r.out.trim().split('\n')[0] || '(none)';
    const head = `# yt-dlp ${ytdlpVersion}\n# cookies: ${!!COOKIES}\n# pot provider: ${provider}\n`
      + `# js-runtimes: ${jsr || '(yt-dlp default)'}\n# remote-components: ${remote || '(none)'}\n# extractor-args: ${extractor || '(none)'}\n# exit: ${r.code}\n# url: ${url}\n\n`;
    res.writeHead(r.code === 0 ? 200 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end((head + '===== STDERR (verbose) =====\n' + r.err + '\n===== STDOUT =====\n' + r.out).slice(0, 80000));
  }

  if (path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><title>ESM lofi relay</title>
<body style="font:16px system-ui;background:#111;color:#eee;padding:2rem;max-width:42rem;margin:auto">
<h1>🎧 ESM lofi relay</h1>
<p>Always-on MP3 of the Lofi Girl live feed for the office TVs — no video, no ads.</p>
<p>Stream URL: <code>/lofi.mp3</code></p>
<audio controls autoplay src="/lofi.mp3"></audio>
<p><a style="color:#8bf" href="/status">/status</a> · <a style="color:#8bf" href="/diag">/diag</a></p>`);
  }

  if (path === '/lofi.mp3' || path === '/lofi') {
    if (listeners.size >= MAX_LISTENERS) {
      log('rejecting listener: at MAX_LISTENERS', MAX_LISTENERS);
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '30' });
      return res.end('relay at capacity');
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*', // TVs load this cross-origin from the Pages site
    });
    res.flushHeaders(); // send headers now so the TV connects without waiting for the first audio byte
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    for (const chunk of prebuffer) res.write(chunk); // instant-start burst
    listeners.add(res);
    log('listener +1 ->', listeners.size);
    startPipeline();

    const drop = () => removeListener(res);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  log(`relay listening on :${PORT}, source ${STREAM_URL}`);
  log('binaries -> ffmpeg:', FFMPEG, '| yt-dlp:', YTDLP, '| cookies:', COOKIES ? 'loaded' : 'none');
  runCapture(YTDLP, ['--version'], 10000).then((r) => {
    ytdlpVersion = (r.out || '').trim() || 'unknown';
    log('yt-dlp version:', ytdlpVersion, '| PO-token port:', POT_PORT);
  });
});

process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('SIGTERM', () => { stopPipeline(); server.close(() => process.exit(0)); });
