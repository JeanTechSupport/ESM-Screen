# Bookworm (glibc) base so the standalone yt-dlp_linux binary runs as-is.
FROM node:20-bookworm-slim

# ffmpeg does the transcode; yt-dlp resolves the current live audio URL.
# The yt-dlp_linux release is self-contained (no Python runtime needed).
# The ADD below pulls the "latest release" metadata, which changes every time
# yt-dlp ships a release — that busts Docker's layer cache so a normal redeploy
# fetches the current binary instead of a months-old cached one (YouTube breaks
# old yt-dlp constantly). Force-refresh anytime via "Clear build cache & deploy".
ADD https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest /tmp/ytdlp-release.json
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
      -o /usr/local/bin/yt-dlp \
 && chmod a+rx /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json server.js ./

ENV NODE_ENV=production
EXPOSE 10000
CMD ["node", "server.js"]
