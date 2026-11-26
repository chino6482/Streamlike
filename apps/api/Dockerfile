# Build context = raíz del repo (ver docker-compose.yml) para usar bun.lock y /prisma.
FROM oven/bun:1-slim AS builder
WORKDIR /app

# 1. Dependencias del sistema cacheadas
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# 2. Instalación reproducible de dependencias del monorepo cacheada por lockfile
COPY package.json bun.lock ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
RUN bun install --frozen-lockfile

# 3. Generación de Prisma Client
COPY prisma ./prisma
RUN bun --bun ./node_modules/.bin/prisma generate --schema=prisma/schema.prisma

# 4. Compilación de la API NestJS
COPY apps/api ./apps/api
RUN bun run --cwd apps/api build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json
COPY --from=builder /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/prisma ./prisma

EXPOSE 3000
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy --schema=prisma/schema.prisma && node apps/api/dist/main.js"]
