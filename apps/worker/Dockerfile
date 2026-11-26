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

# 4. Compilación del worker TypeScript
COPY apps/worker ./apps/worker
RUN bun run --cwd apps/worker build

# Runtime en Node 22 slim (glibc): máxima compatibilidad para fluent-ffmpeg,
# ffmpeg-static, OpenCV/MediaPipe y el binario ELF nativo yt-dlp_linux.
FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Capa 1: FFmpeg, libass, fuentes DejaVu y dependencias del sistema para Python/OpenCV/MediaPipe
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg \
    libass9 \
    fontconfig \
    fonts-dejavu-core \
    python3 \
    python3-pip \
    python3-venv \
    libglib2.0-0 \
    libgl1 \
    libgomp1 \
    openssl \
    ca-certificates \
    curl \
  && fc-cache -f \
  && rm -rf /var/lib/apt/lists/*

# Capa 2: Entorno virtual Python cacheado con MediaPipe y OpenCV headless para Auto-Reframe
RUN python3 -m venv /opt/venv \
  && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
  && /opt/venv/bin/pip install --no-cache-dir mediapipe opencv-python-headless
ENV PATH="/opt/venv/bin:$PATH"
ENV FACE_TRACKER_PYTHON="/opt/venv/bin/python3"

# Capa 3: Binario nativo yt-dlp_linux (sin dependencia de Python)
RUN curl -fsSL -o /usr/local/bin/yt-dlp \
    https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
  && chmod +x /usr/local/bin/yt-dlp

# Capa 4: Artefactos compilados, script de tracking facial y dependencias desde builder
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/worker/package.json ./apps/worker/package.json
COPY --from=builder /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/apps/worker/scripts ./apps/worker/scripts

CMD ["node", "apps/worker/dist/worker.js"]
