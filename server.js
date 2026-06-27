'use strict';
/**
 * ESM-Screen lofi relay (SoundCloud edition)
 * --------------------------------------------------------------------------
 * Streams Lofi Girl's catalogue as a plain, always-on MP3 the office TVs play
 * in their existing <audio> element — no video, no ads, no YouTube.
 *
 * Why SoundCloud and not the YouTube live feed: YouTube bot-walls datacenter
 * IPs (Render) at the login layer, and the only thing that gets past it —
 * account cookies — gets invalidated within hours. SoundCloud hosts the same
 * Lofi Girl label catalogue and resolves cleanly from a server with plain
 * yt-dlp (no cookies / PO tokens / JS runtime needed). We flat-list the source
 * into track permalinks, shuffle, then resolve + transcode them one after
 * another, looping forever. The TVs hit one stable URL (/lofi.mp3) throughout.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ffmpeg/yt-dlp: in Docker they're system packages on PATH (apt ffmpeg, pip
// yt-dlp); locally they fall back to PATH too. Env vars override.
function tryRequire(name) { try { return require(name); } catch { return null; } }
const FFMPEG = process.env.FFMPEG_PATH || tryRequire('ffmpeg-static') || 'ffmpeg';
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';

const PORT = parseInt(process.env.PORT, 10) || 10000;
// A SoundCloud user/playlist/track URL. The profile resolves to "Lofi Girl (All)".
const SOURCE_URL = process.env.STREAM_URL || 'https://soundcloud.com/lofi_girl';
const BITRATE = process.env.BITRATE || '128k';
const SHUFFLE = process.env.SHUFFLE !== '0';                                  // shuffle the catalogue by default
const MAX_TRACKS = parseInt(process.env.MAX_TRACKS, 10) || 300;              // cap how many tracks we list
const RELIST_MS = parseInt(process.env.RELIST_MS, 10) || 6 * 60 * 60 * 1000; // refresh the track list every 6h
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS, 10) || 60000;  // stop after the last TV leaves
const PREBUFFER_BYTES = parseInt(process.env.PREBUFFER_BYTES, 10) || 256 * 1024; // instant-start burst
const MAX_LISTENERS = parseInt(process.env.MAX_LISTENERS, 10) || 50;
const MAX_CLIENT_BACKLOG = parseInt(process.env.MAX_CLIENT_BACKLOG, 10) || 4 * 1024 * 1024;

/** @type {Set<import('http').ServerResponse>} */
const listeners = new Set();
let proc = null;            // current { ffmpeg } or null
let starting = false;       // guard against concurrent starts
let restartTimer = null;
let idleTimer = null;
let backoffMs = 1000;
let lastError = null;
let lastStderr = null;      // stderr tail from the last failed resolve (diagnostics)

let tracks = [];            // track permalink URLs to play in order
let trackIdx = 0;
let tracksLoadedAt = 0;
let currentTrack = null;
let ytdlpVersion = 'unknown';

function log(...a) { console.log(new Date().toISOString(), ...a); }

// Instant-start ring buffer of the most recent MP3 bytes.
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

function removeListener(res) {
  if (!listeners.delete(res)) return;
  log('listener -1 ->', listeners.size);
  if (listeners.size === 0) scheduleIdleStop();
}

// Run a command to completion, capturing stdout/stderr. Never rejects.
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

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Flat-list the source into track permalinks (fast; doesn't resolve media URLs).
// Cached; refreshed every RELIST_MS so new releases get picked up.
async function loadTracks(force) {
  if (!force && tracks.length && (Date.now() - tracksLoadedAt) < RELIST_MS) return;
  log('loading track list from', SOURCE_URL);
  const r = await runCapture(YTDLP, [
    '--flat-playlist', '--print', '%(url)s',
    '--playlist-end', String(MAX_TRACKS), '--no-warnings', SOURCE_URL,
  ], 120000);
  let urls = r.out.split('\n').map((s) => s.trim()).filter((u) => /^https?:\/\//.test(u));
  if (!urls.length) {                 // not a playlist (single track / direct) -> use as-is
    urls = [SOURCE_URL];
    if (r.code !== 0) lastError = 'track list load failed: ' + (r.err.trim().slice(-300) || 'no entries');
  }
  if (SHUFFLE) shuffle(urls);
  tracks = urls;
  trackIdx = 0;
  tracksLoadedAt = Date.now();
  log('loaded', tracks.length, 'tracks');
}

// Resolve one track permalink to a fresh, direct media URL (SoundCloud URLs expire).
async function resolveTrack(permalink) {
  const r = await runCapture(YTDLP, ['-g', '-f', 'bestaudio/best', '--no-playlist', '--no-warnings', permalink], 60000);
  const url = r.out.split('\n').map((s) => s.trim()).filter(Boolean)[0];
  if (r.code === 0 && url) { lastStderr = null; return url; }
  lastStderr = r.err;
  throw new Error(`yt-dlp exited ${r.code}: ${r.err.trim().slice(-200) || 'no URL returned'}`);
}

async function startPipeline() {
  if (proc || starting) return;
  starting = true;
  try {
    await loadTracks(false);
    if (!tracks.length) throw new Error('no tracks to play');
    const permalink = tracks[trackIdx % tracks.length];
    currentTrack = permalink;
    log(`resolving track ${trackIdx + 1}/${tracks.length} ->`, permalink);
    const url = await resolveTrack(permalink);
    log('resolved; starting ffmpeg transcode ->', BITRATE, 'mp3');
    const ffmpeg = spawn(FFMPEG, [
      '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', url,
      '-vn',
      '-acodec', 'libmp3lame', '-b:a', BITRATE,
      '-f', 'mp3', 'pipe:1',
    ]);
    proc = { ffmpeg };
    ffmpeg.stdout.on('data', (chunk) => {
      backoffMs = 1000;                 // healthy data -> reset backoff
      remember(chunk);
      for (const res of listeners) {
        try {
          res.write(chunk);
          if (res.writableLength > MAX_CLIENT_BACKLOG) {
            log('dropping slow listener (backlog over limit)');
            res.destroy();
            removeListener(res);
          }
        } catch { removeListener(res); }
      }
    });
    ffmpeg.stderr.on('data', (d) => { lastError = d.toString().trim(); });
    let advanced = false;
    const onExit = (why, ok) => {
      if (!proc) return;
      proc = null;
      clearPrebuffer();
      log('track ended:', why, '— listeners:', listeners.size);
      if (!advanced) { advanced = true; trackIdx = (trackIdx + 1) % tracks.length; } // advance to next track
      if (listeners.size > 0) scheduleRestart(ok);
    };
    ffmpeg.on('error', (e) => { lastError = String(e); onExit('ffmpeg error', false); });
    ffmpeg.on('close', (code) => onExit(`ffmpeg closed ${code}`, code === 0));
  } catch (e) {
    lastError = String((e && e.message) || e);
    log('start failed:', lastError);
    if (tracks.length) trackIdx = (trackIdx + 1) % tracks.length; // skip a bad/expired track
    if (listeners.size > 0) scheduleRestart(false);
  } finally {
    starting = false;
  }
}

function scheduleRestart(ok) {
  if (restartTimer || proc) return;
  const wait = ok ? 250 : backoffMs;            // quick segue between good tracks; back off on errors
  if (!ok) backoffMs = Math.min(backoffMs * 2, 30000);
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
  const route = (req.url || '/').split('?')[0];

  if (route === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }

  if (route === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      source: SOURCE_URL,
      listeners: listeners.size,
      upstream: proc ? 'playing' : 'stopped',
      tracks: tracks.length,
      trackIndex: trackIdx,
      currentTrack,
      shuffle: SHUFFLE,
      ytdlpVersion,
      lastError,
      lastStderrTail: lastStderr ? lastStderr.slice(-1500) : null,
    }, null, 2));
  }

  // Debug probe: /diag resolves the first track of the source (verbose),
  // /diag?url=X resolves X, /diag?list lists the source's track permalinks.
  if (route === '/diag') {
    const q = new URL(req.url, 'http://x').searchParams;
    const target = q.get('url') || SOURCE_URL;
    const args = q.has('list')
      ? ['--flat-playlist', '--print', '%(url)s', '--playlist-end', '25', target]
      : ['-v', '-g', '-f', 'bestaudio/best', '--playlist-items', '1', target];
    const r = await runCapture(YTDLP, args, 120000);
    const url = r.out.trim().split('\n')[0] || '(none)';
    const head = `# yt-dlp ${ytdlpVersion}\n# target: ${target}\n# mode: ${q.has('list') ? 'list' : 'resolve'}\n# exit: ${r.code}\n# url: ${url}\n\n`;
    res.writeHead(r.code === 0 ? 200 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end((head + '===== STDOUT =====\n' + r.out + '\n===== STDERR =====\n' + r.err).slice(0, 80000));
  }

  if (route === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(`<!doctype html><meta charset=utf-8><title>ESM lofi relay</title>
<body style="font:16px system-ui;background:#111;color:#eee;padding:2rem;max-width:42rem;margin:auto">
<h1>🎧 ESM lofi relay</h1>
<p>Always-on MP3 of the Lofi Girl catalogue (via SoundCloud) for the office TVs — no video, no ads.</p>
<p>Stream URL: <code>/lofi.mp3</code></p>
<audio controls autoplay src="/lofi.mp3"></audio>
<p><a style="color:#8bf" href="/status">/status</a> · <a style="color:#8bf" href="/diag">/diag</a></p>`);
  }

  if (route === '/lofi.mp3' || route === '/lofi') {
    if (listeners.size >= MAX_LISTENERS) {
      log('rejecting listener: at MAX_LISTENERS', MAX_LISTENERS);
      res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '30' });
      return res.end('relay at capacity');
    }
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.flushHeaders();
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    for (const chunk of prebuffer) res.write(chunk);
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
  log(`relay listening on :${PORT}, source ${SOURCE_URL}`);
  log('binaries -> ffmpeg:', FFMPEG, '| yt-dlp:', YTDLP, '| shuffle:', SHUFFLE);
  runCapture(YTDLP, ['--version'], 10000).then((r) => {
    ytdlpVersion = (r.out || '').trim() || 'unknown';
    log('yt-dlp version:', ytdlpVersion);
  });
  loadTracks(true).catch((e) => log('initial track load failed:', String(e)));
});

process.on('uncaughtException', (e) => log('uncaughtException', e));
process.on('SIGTERM', () => { stopPipeline(); server.close(() => process.exit(0)); });
