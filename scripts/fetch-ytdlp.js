'use strict';
/**
 * Downloads the standalone yt-dlp Linux binary into ./bin so the relay works on
 * Render's native Node runtime (where we can't apt-get install it). Runs as an
 * npm `postinstall`. No-ops on non-Linux and when the binary is already present.
 * In Docker we install yt-dlp via the system package instead, so this is skipped
 * there (Docker doesn't run `npm install`).
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const URL = process.env.YTDLP_DOWNLOAD_URL
  || 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux';
const BIN_DIR = path.join(__dirname, '..', 'bin');
const DEST = path.join(BIN_DIR, 'yt-dlp');

if (process.platform !== 'linux') {
  console.log('[fetch-ytdlp] not linux; skipping (relay expects yt-dlp on PATH locally)');
  process.exit(0);
}
if (fs.existsSync(DEST)) {
  console.log('[fetch-ytdlp] yt-dlp already present at', DEST);
  process.exit(0);
}

fs.mkdirSync(BIN_DIR, { recursive: true });

function download(url, redirects = 0) {
  if (redirects > 5) throw new Error('too many redirects fetching yt-dlp');
  https.get(url, { headers: { 'User-Agent': 'esm-lofi-relay' } }, (res) => {
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      return download(res.headers.location, redirects + 1);
    }
    if (res.statusCode !== 200) {
      console.error('[fetch-ytdlp] download failed, HTTP', res.statusCode);
      process.exit(1);
    }
    const tmp = DEST + '.tmp';
    const out = fs.createWriteStream(tmp);
    res.pipe(out);
    out.on('finish', () => out.close(() => {
      fs.chmodSync(tmp, 0o755);
      fs.renameSync(tmp, DEST);
      console.log('[fetch-ytdlp] installed yt-dlp ->', DEST);
    }));
  }).on('error', (e) => {
    console.error('[fetch-ytdlp] error:', e.message);
    process.exit(1);
  });
}

download(URL);
