# Melofon — LAN run. The library path is configuration, never baked in:
# MELOFON_LIBRARY points at the bind-mount inside the container.
#
#   docker build -t melofon .
#   docker run -d --name melofon \
#     -e MELOFON_LISTEN=0.0.0.0:8000 \
#     -e MELOFON_USER=admin -e MELOFON_PASSWORD=change-me \
#     -e MELOFON_SECRET=another-secret \
#     -e MELOFON_LIBRARY=/music \
#     -v melofon-data:/data \
#     -v /path/to/music:/music:ro \
#     -p 8000:8000 \
#     melofon
#
# Pick the published port so it does not steal Navidrome's 4533 (dual-run).
FROM denoland/deno:2.9.6

WORKDIR /app
COPY . .
# Warm the dependency cache (jsr + npm, incl. the DuckDB native binding).
RUN deno install --entrypoint main.ts

ENV MELOFON_DATA=/data
VOLUME /data
EXPOSE 8000

CMD ["deno", "task", "start"]
