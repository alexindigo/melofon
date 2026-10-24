# Melofon — LAN run. Scan sources are rows in the database, added once via
# the admin API (POST /api/v1/admin/libraries {"name", "path"}) against the bind-mounted
# music path inside the container.
#
#   docker build -t melofon .
#   docker run -d --name melofon \
#     -e MELOFON_LISTEN=0.0.0.0:8000 \
#     -e MELOFON_USER=admin -e MELOFON_PASSWORD=change-me \
#     -e MELOFON_SECRET=another-secret \
#     -v melofon-data:/data \
#     -v /path/to/music:/music:ro \
#     -p 8000:8000 \
#     melofon
#   url=http://melofon.home:8000
#   curl -c cookies.txt -H 'content-type: application/json' -H "Origin: $url" \
#     -d '{"username":"admin","password":"change-me"}' "$url/api/v1/session"
#   curl -b cookies.txt -H 'content-type: application/json' -H "Origin: $url" \
#     -d '{"name":"Music","path":"/music"}' "$url/api/v1/admin/libraries"
#
# /_/health stays public. Other /_/ admin routes are loopback-only: run their
# requests inside the container or VM, not through Docker's published port.
#
# Pick the published port so it does not steal Navidrome's 4533 (dual-run).
#
# AirPlay: streaming works on plain bridged networking (manual registration —
# POST /_/outputs or MELOFON_AIRPLAY_HOST=<ip>[:port]). Discovery (mDNS, on by
# default; PUT /_/config/airplay.mdns to toggle) needs LAN multicast: run
# with --network host or a macvlan network, or turn discovery off.

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
