# Base off the official bgutil PO-token provider image. It already bundles the
# provider server (Node) plus its native deps (canvas/jsdom/BotGuard), so we
# don't rebuild any of that or risk an ABI/lib mismatch. We add ffmpeg, yt-dlp,
# the bgutil yt-dlp PLUGIN, and the relay on top, then run the provider and the
# relay together in one container, wired over localhost.
#
# Why: from a datacenter IP (Render) YouTube bot-walls yt-dlp even with cookies.
# The provider mints the proof-of-origin (PO) tokens YouTube now demands; the
# plugin hands them to yt-dlp automatically. Combined with the cookies secret
# file, this gets the real Lofi Girl live stream resolving reliably.
FROM brainicism/bgutil-ytdlp-pot-provider:latest

USER root

# ffmpeg: the audio transcode. python3/pip: yt-dlp + the bgutil PO-token plugin
# (client side), via pip so yt-dlp auto-discovers the plugin. tini: reap the
# provider's child processes (we run two processes in one container).
# The ADD busts the pip layer whenever a new yt-dlp release ships, so a normal
# redeploy pulls the current yt-dlp; "Clear build cache & deploy" forces it.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*
ADD https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest /tmp/ytdlp-release.json
RUN pip3 install --no-cache-dir --break-system-packages -U \
      yt-dlp bgutil-ytdlp-pot-provider

# The relay itself.
WORKDIR /relay
COPY package.json server.js start.sh ./
RUN chmod +x start.sh

ENV NODE_ENV=production
EXPOSE 10000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/relay/start.sh"]
