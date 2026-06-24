#!/bin/sh
# Launch the bundled bgutil PO-token provider (Node HTTP server on
# 127.0.0.1:4416) in the background, then exec the relay as the container's main
# process. yt-dlp's bgutil plugin auto-discovers the provider at the default
# localhost port, which is what gets us past YouTube's "confirm you're not a bot"
# wall from Render's datacenter IP. Both processes log to the container stdout.
echo "[start] launching PO-token provider on 127.0.0.1:4416"
( cd /app && node build/main.js ) &
echo "[start] launching relay"
exec node /relay/server.js
