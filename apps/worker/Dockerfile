# Build context = raíz del repo (ver docker-compose.yml) para usar el schema
# Prisma único de /prisma.
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache ffmpeg openssl
COPY apps/worker/package.json apps/worker/package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY apps/worker .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine
WORKDIR /app
# ffmpeg (procesado + static) + yt-dlp (descarga desde YouTube/TikTok/etc.) + python3 (runtime de yt-dlp)
RUN apk add --no-cache ffmpeg openssl curl ca-certificates python3
RUN curl -L -o /usr/local/bin/yt-dlp https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp && chmod +x /usr/local/bin/yt-dlp
COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/worker.js"]
