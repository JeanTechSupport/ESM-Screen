# Lofi relay — SoundCloud edition.
#
# SoundCloud resolves cleanly from a datacenter IP with plain yt-dlp, so this is
# just ffmpeg + yt-dlp + the relay. None of the YouTube anti-bot machinery is
# needed any more (no PO-token provider, no Deno, no cookies) — which also drops
# the memory pressure that risked OOM on the free plan.
#
# yt-dlp[default] pulls curl_cffi for SoundCloud's impersonation. The ADD busts
# the pip layer whenever a new yt-dlp release ships, so a normal redeploy pulls
# the current version (force a clean rebuild with "Clear build cache & deploy").
FROM node:20-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ADD https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest /tmp/ytdlp-release.json
RUN pip3 install --no-cache-dir --break-system-packages -U "yt-dlp[default]"

WORKDIR /app
COPY package.json server.js ./

ENV NODE_ENV=production \
    STREAM_URL=https://soundcloud.com/lofi_girl
EXPOSE 10000
CMD ["node", "server.js"]
