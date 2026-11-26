# Build context = raíz del repo (ver docker-compose.yml) para usar bun.lock.
FROM oven/bun:1-slim AS builder
WORKDIR /app

# 1. Instalación reproducible de dependencias del monorepo cacheada por lockfile
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile

# 2. Build de Next.js (variables NEXT_PUBLIC_* en build-time)
COPY apps/web ./apps/web
ARG NEXT_PUBLIC_API_URL
ARG NEXT_PUBLIC_API_KEY
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_API_KEY=$NEXT_PUBLIC_API_KEY
RUN bun run --cwd apps/web build

# Runtime en Node 22 slim (glibc): compatible con el binario nativo yt-dlp_linux
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Capa cacheada de ffmpeg + ca-certificates para yt-dlp_linux y clips MP4
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/web/package.json ./apps/web/package.json
COPY --from=builder /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=builder /app/apps/web/.next ./apps/web/.next
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder /app/apps/web/next.config.js ./apps/web/next.config.js
# Binario nativo yt-dlp_linux empaquetado en el repo (sin bit de ejecución en Git)
COPY --from=builder /app/apps/web/bin/yt-dlp ./apps/web/bin/yt-dlp
RUN chmod +x ./apps/web/bin/yt-dlp

EXPOSE 3000
WORKDIR /app/apps/web
CMD ["./node_modules/.bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
