# Melofon — LAN run. Scan sources are rows in the database, added once via
# the admin API (POST /api/v1/admin/libraries {"name", "path"}) against the bind-mounted
# music path inside the container.
#
#   docker build -t melofon .
#   docker run -d --restart unless-stopped --name melofon \
#     -e MELOFON_LISTEN=0.0.0.0:8000 \
#     -e MELOFON_USER=admin -e MELOFON_PASSWORD=change-me \
#     -e MELOFON_SECRET=another-secret \
#     -v melofon-data:/data \
#     -v /path/to/music:/music:ro \
#     -p 8000:8000 \
#     melofon
# Omit MELOFON_USER/MELOFON_PASSWORD for setup: read the code in the startup
# log, open /setup, then POST /setup {"code","username","password"} with a
# matching Origin. Melofon sends 201 and exits 75; a restart policy is required.
# systemd: Restart=on-failure (or always). Docker Compose: restart: unless-stopped.
# Started by hand, start it again after setup; sign in with the new admin below.
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

# Shared native dependencies. The dev target stops before any source COPY.
ARG BROWSER_BASE=dev
FROM denoland/deno:2.9.6 AS native-base
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential pkg-config \
    libevent-dev \
    libavcodec-dev libavformat-dev libavfilter-dev libavutil-dev \
    libjson-c-dev libgcrypt20-dev libgpg-error-dev libsodium-dev \
    libplist-dev libunistring-dev uuid-dev libcurl4-openssl-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# Development and CI use a bind-mounted checkout, not an image source snapshot.
FROM native-base AS dev
RUN apt-get update && apt-get install -y --no-install-recommends \
    git ca-certificates ffmpeg python3 iproute2 util-linux \
  && rm -rf /var/lib/apt/lists/* \
  && cat /proc/sys/kernel/random/uuid > /usr/local/share/melofon-native-build-id
ENV DENO_DIR=/app/.test-tmp/deno
ENV MELOFON_RAOP_LIB=/app/helper/raop/libmelofon_raop.so
CMD ["sleep", "infinity"]

# CI passes the exact dev image restored from preparation as BROWSER_BASE.
FROM ${BROWSER_BASE} AS browser
ARG BROWSER_UID=1000
ARG BROWSER_GID=1000
# Keep the Chromium pin installable after it rotates out of stable-security.
# APT still verifies the archived Debian signature and package hashes.
RUN echo 'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20261123T154646Z/ trixie-security main' \
      > /etc/apt/sources.list.d/chromium-snapshot.list \
  && apt-get update -o Acquire::Retries=3 --error-on=any \
  && apt-get install -y --no-install-recommends \
    chromium=156.0.8078.108-1~deb13u1 chromium-common=156.0.8078.108-1~deb13u1 \
    nginx sudo \
  && rm -rf /var/lib/apt/lists/* /etc/apt/sources.list.d/chromium-snapshot.list
# Match the bind mount owner. Only the test ingress uses sudo, inside this image.
RUN (getent group "$BROWSER_GID" || groupadd -g "$BROWSER_GID" tester) \
  && useradd -m -u "$BROWSER_UID" -g "$BROWSER_GID" tester \
  && echo 'tester ALL=(root) NOPASSWD: /usr/sbin/nginx' > /etc/sudoers.d/test-ingress \
  && chmod 0440 /etc/sudoers.d/test-ingress
ENV HOME=/home/tester
USER tester

# --- Build stage: compile the RAOP FFI library (users never see a compiler).
FROM native-base AS build
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
