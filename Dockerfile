# Bookworm (glibc) base so the standalone yt-dlp_linux binary runs as-is.
FROM node:20-bookworm-slim

# ffmpeg does the transcode; yt-dlp resolves the current live audio URL.
# The yt-dlp_linux release is self-contained (no Python runtime needed).
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
