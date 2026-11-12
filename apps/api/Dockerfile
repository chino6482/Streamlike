# Build context = raíz del repo (ver docker-compose.yml) para poder usar el
# schema Prisma único que vive en /prisma.
FROM node:20-alpine AS builder
WORKDIR /app
RUN apk add --no-cache openssl
# Instalación reproducible con lockfile propio de la app
COPY apps/api/package.json apps/api/package-lock.json ./
RUN npm ci
# Schema + migraciones canónicas del monorepo
COPY prisma ./prisma
COPY apps/api .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache openssl
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
EXPOSE 3000
# Aplica migraciones pendientes y arranca la API
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
