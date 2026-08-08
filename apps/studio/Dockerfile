# Build from the repository root:
# docker build -f apps/studio/Dockerfile -t mekka-studio .
#
# Run with persistent SQLite data and an access token:
# docker run --rm -p 3000:3000 -v mekka-data:/data \
#   -e MEKKA_STUDIO_ACCESS_TOKEN=replace-with-at-least-24-random-characters \
#   mekka-studio

FROM oven/bun:1.3.14 AS bun-runtime

FROM node:22-slim AS build

ARG NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3000
ARG NEXT_PUBLIC_MEKKA_GATEWAY_URL=http://127.0.0.1:3000
ENV NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL} \
  NEXT_PUBLIC_MEKKA_GATEWAY_URL=${NEXT_PUBLIC_MEKKA_GATEWAY_URL}

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends \
  ca-certificates \
  build-essential \
  git \
  python3 && \
  rm -rf /var/lib/apt/lists/* && \
  update-ca-certificates

WORKDIR /app
COPY . .

RUN bun install --frozen-lockfile
RUN bun run build:core
RUN bun run build:studio

FROM node:22-slim AS production

COPY --from=bun-runtime /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update -qq && \
  apt-get install -y --no-install-recommends ca-certificates curl && \
  rm -rf /var/lib/apt/lists/* && \
  update-ca-certificates

WORKDIR /app
COPY --from=build /app ./

ENV NODE_ENV=production \
  MODE=production \
  PORT=3000 \
  STUDIO_BACKEND_API_URL=http://127.0.0.1:3001 \
  SQLITE_META_HOST=127.0.0.1 \
  SQLITE_META_PORT=3001 \
  SQLITE_META_DATA_DIRECTORY=/data/sqlite-meta \
  MEKKA_SQLITE_META_SERVICE=1

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
  CMD curl --fail --silent http://127.0.0.1:3000/api/health/ready > /dev/null || exit 1

CMD ["bun", "run", "--cwd", "apps/studio", "start:production"]
