FROM denoland/deno:bin-2.9.6 AS deno
FROM mcr.microsoft.com/devcontainers/base:debian
COPY --from=deno /deno /usr/local/bin/deno
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
