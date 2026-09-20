# Melofon — LAN run. Scan sources are rows in the database, added once via
# the core API (POST /_/libraries {"name", "path"}) against the bind-mounted
# music path inside the container.
#
#   docker build -t melofon .
#   docker run -d --name melofon \
#     -e MELOFON_LISTEN=0.0.0.0:8000 \
#     -e MELOFON_USER=admin -e MELOFON_PASSWORD=change-me \
#     -e MELOFON_SECRET=another-secret \
#     -e MELOFON_AIRPLAY_HOST=192.0.2.10 \
#     -v melofon-data:/data \
#     -v /path/to/music:/music:ro \
#     -p 8000:8000 \
#     melofon
#   curl -X POST -H 'content-type: application/json' \
#     -d '{"name": "Music", "path": "/music"}' http://127.0.0.1:8000/_/libraries
#
# Pick the published port so it does not steal Navidrome's 4533 (dual-run).

# --- Build stage: compile the RAOP FFI library (users never see a compiler).
FROM denoland/deno:2.9.6 AS build
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config \
    libevent-dev \
    libavcodec-dev libavformat-dev libavfilter-dev libavutil-dev \
    libjson-c-dev libgcrypt20-dev libgpg-error-dev libsodium-dev \
    libplist-dev libunistring-dev uuid-dev libcurl4-openssl-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN make -C helper/raop

# --- Final image: runtime libs only, plus the built .so.
FROM denoland/deno:2.9.6
RUN apt-get update && apt-get install -y --no-install-recommends \
    libevent-2.1-7t64 libevent-pthreads-2.1-7t64 \
    libavcodec61 libavformat61 libavfilter10 libavutil59 \
    libjson-c5 libgcrypt20 libgpg-error0 libsodium23 \
    libplist-2.0-4 libunistring5 libuuid1 libcurl4t64 \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
COPY --from=build /app/helper/raop/libmelofon_raop.so helper/raop/libmelofon_raop.so
# Warm the dependency cache (jsr + npm, incl. the DuckDB native binding).
RUN deno install --entrypoint main.ts

ENV MELOFON_DATA=/data
VOLUME /data
EXPOSE 8000

CMD ["deno", "task", "start"]
