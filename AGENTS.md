# AGENTS.md

## Arquitectura (cambió el 2026-11-17)
- La **app principal ahora es `apps/web`** (Next.js 14): procesa videos ella misma
  mediante API routes internas (`app/videos`, `app/upload/mock`, `app/api/ai/enhance-clips`)
  usando un store en memoria + archivos temporales (`lib/mock-store.ts`) y ffmpeg/yt-dlp
  del sistema (`lib/video-processor.ts`). El estado NO persiste: se pierde al reiniciar.
- `apps/api` (NestJS + Prisma + BullMQ) y `apps/worker` siguen en el repo y se
  construyen en Docker, pero ya no forman parte de `npm run dev`/`build` del root.
- Los scripts del root (`dev`, `build`, `start`) solo ejecutan `apps/web`.

## Comandos
- `npm run dev` → solo la web, en **puerto 3000** (`next dev -p 3000 -H 0.0.0.0`).
  Si levantas también la API en local, chocarán en el 3000.
- Docker: `docker compose up -d --build` → web en **http://localhost:3001**
  (mapeo 3001:3000), API en 3000. El compose arranca postgres, redis y localstack
  (la web actual no los usa, pero siguen como dependencias).
- Build rápido de verificación: `npm run build` (web), `npm --workspace=@streamlike/api run build`,
  `npm --workspace=@streamlike/worker run build`.
- Para crear el lockfile de `apps/web` (lo usa el `npm ci` de su Dockerfile):
  copiar `package.json`+`package-lock.json` a un dir temporal y correr
  `npm install --package-lock-only` ahí. Los workspaces de npm actualizan el
  lockfile del root, NO el de `apps/web`.

## Gotchas del toolchain
- `apps/web/bin/yt-dlp` es un **binario ELF de Linux** versionado sin bit de
  ejecución (100644). Solo sirve en Docker/Linux; en Windows se usa el `yt-dlp`
  del PATH (`winget install yt-dlp.yt-dlp`). ffmpeg/ffprobe van en la imagen web
  vía `apk add ffmpeg` (ver Dockerfile del web).
- Gestores de paquetes mezclados: `bun.lock` en el root (deploy a PaaS usa bun)
  + `package-lock.json` del root + lockfiles por app. Al tocar dependencias,
  actualizar todos los lockfiles afectados.
- `@google/genai` está declarado en el root Y en `apps/web/package.json`;
  si falta en el lockfile del web, el build de Docker falla.
- El feature de IA (`/api/ai/enhance-clips`, `lib/gemini-clips.ts`) requiere
  `GEMINI_API_KEY`; si no está, responde 503 con mensaje claro (no es un bug).
  `.env.example` viene con valores vacíos: rellenar `DATABASE_URL`, `REDIS_URL`,
  `S3_*` (valores por defecto en el README) según el entorno.
- Seguridad: `lib/ssrf-guard.ts` (y su copia en `apps/api/src/common/`) valida que
  las `sourceUrl` resuelvan solo a IPs públicas. Es intencional que bloquee
  localhost/IPs privadas/link-local en desarrollo.
