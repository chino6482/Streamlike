# HANDOFF — StreamLike

- **Fecha:** 2026-11-13 · **Repo:** https://github.com/chino6482/Streamlike (público, `main`)
- **Commits:** `a0a5cd0` (proyecto) · `4b7bc12` (docs)
- **Detalle histórico completo:** `AI_HANDOFF.md` (577 líneas)

---

## 1. Estado actual — qué funciona (verificado)

- [x] **Upload** drag&drop → URL presignada → S3 → `POST /videos` → cola → worker → clips → BD → web
- [x] **Desde enlace**: YouTube / TikTok / Instagram / X / Vimeo (`yt-dlp`) y MP4 directo (ffmpeg HTTP)
- [x] **Clips**: 15 s, 2 formatos (VERTICAL 1080×1920 + HORIZONTAL), score 0-100, máx. 10 highlights
- [x] **Heurística**: audio `ebur128` 50 % + habla 30 % + cortes de escena 20 %
- [x] **Descarga del video completo** (`keepOriginal`) → `GET /videos/:id/download` (presignada, 15 min)
- [x] **Borrado completo** `DELETE /videos/:id` (objetos S3 + registros BD)
- [x] **Web en tiempo real** (Socket.IO): estado, fase, toasts, modal, stats, eliminar, procesar-desde-enlace
- [x] **Prisma**: schema único en `/prisma/schema.prisma`; migraciones aplicadas al arrancar la API
- [x] **Typecheck** api / worker / web: OK · **Builds** Docker: OK
- [x] **E2E**: YouTube 634 s → 24 clips · enlace + original 20 MB → descarga real HTTP 206

**Puertos:** web `3001` · api `3000` · postgres `5432` · redis `6379` · localstack `4566`

---

## 2. Archivos exactos modificados / creados

**Creados**

| Ruta | Motivo |
|---|---|
| `README.md` | Docs del repo público |
| `.gitignore` · `.env.example` | `.env` fuera del repo |
| `AI_HANDOFF.md` | Traspaso histórico detallado |
| `prisma/migrations/0_init/migration.sql` | Migración inicial |
| `prisma/migrations/1_add_video_source_fields/migration.sql` | `Video.sourceUrl` + `Video.originalKey` |
| `prisma/migrations/migration_lock.toml` | Lock de migraciones |
| `apps/api/src/redis.config.ts` | `parseRedisUrl()` |
| `apps/api/src/s3/s3.module.ts` | `S3_CLIENT` global compartido |
| `apps/api/src/common/api-key.guard.ts` | Guard opcional `x-api-key` |
| `apps/api/package-lock.json` · `apps/worker/package-lock.json` · `apps/web/package-lock.json` | Builds reproducibles (`npm ci`) |

**Modificados**

| Ruta | Cambio clave |
|---|---|
| `apps/worker/src/worker.ts` | Checksum AWS, `ebur128` + regex ffmpeg 8, `analyzeScenes`, crop 1080×1920, `MAX_CLIPS=10`, `SPEECH_THRESHOLD_LUFS=-40`, `downloadSource()` (yt-dlp), `keepOriginal`, `FAILED` persistido, `parseRedisUrl`, `os.tmpdir()` |
| `apps/worker/Dockerfile` | `ffmpeg` + `curl` + `ca-certificates` + `python3` + binario `yt-dlp` |
| `apps/api/src/video/video.service.ts` | `@nestjs/bullmq`, `sourceUrl`/`keepOriginal`, `remove()`, `getDownloadUrl()` |
| `apps/api/src/video/video.controller.ts` | `DELETE /videos/:id`, `GET /videos/:id/download` |
| `apps/api/src/video/dto/create-video.dto.ts` | `sourceUrl?`, `keepOriginal?` |
| `apps/api/src/video/video.gateway.ts` | `handleConnection` + API key |
| `apps/api/src/app.module.ts` · `video.module.ts` | `@nestjs/bullmq` + `S3Module` |
| `apps/api/src/main.ts` | `useGlobalGuards(new ApiKeyGuard())` |
| `apps/api/src/redis.service.ts` | URL directa a ioredis |
| `apps/api/src/upload/upload.service.ts` | `onModuleInit` (bucket idempotente) + host presign |
| `apps/api/src/upload/upload.module.ts` | `S3Module` + checksum `WHEN_REQUIRED` |
| `apps/web/app/page.tsx` | `useCallback`, API key, duración, fase, FAILED, stats, toast, modal, eliminar, procesar-desde-enlace, checkbox "Guardar el video completo", botón "Descargar video completo" |
| `apps/web/app/layout.tsx` · `globals.css` | UI moderna (aurora, glassmorphism) |
| `apps/web/package.json` | Tipos/TS corregidos (`@types/react@^18`, `ts@^5.4.2`) |
| `apps/api/package.json` · `apps/worker/package.json` | AWS SDK `3.1166.0`, `@nestjs/bullmq`, sin `ffprobe-static` |
| `prisma/schema.prisma` | `sourceUrl`, `originalKey`, `binaryTargets` (linux-musl) |
| `docker-compose.yml` | Context raíz, `dns: [8.8.8.8, 8.8.4.4]` (worker), init+persistencia LocalStack |
| `package.json` (raíz) | Scripts `dev:*`, `build:*`, `prisma:*` |
| `.env` | `NEXT_PUBLIC_API_URL`, docs `API_KEY` |
| `.dockerignore` | Excluye `node_modules`, `.next`, `dist`, `.env` |

**Eliminados:** `apps/api/prisma/` · `apps/worker/prisma/` · `apps/web/yarn.lock` · `apps/web/tsconfig.tsbuildinfo`

---

## 3. Bugs pendientes / siguiente tarea

**Pendientes**

- [ ] **Análisis semántico real** ← *tarea principal*: transcripción (Whisper) + LLM para "score viral" semántico. Hoy el score es heurístico audiovisual
- [ ] **CI**: GitHub Actions (build + typecheck de api/worker/web)
- [ ] **LICENSE** (repo público sin licencia)
- [ ] **Límite de descarga**: `MAX_SOURCE_MB` / timeout — un enlace puede bajar 722 MB
- [ ] **Auth completa** (JWT + roles); `API_KEY` existe pero desactivada por defecto
- [ ] **`yt-dlp` sin JS runtime (deno)**: YouTube/TikTok OK hoy; formatos nuevos de YouTube podrían requerirlo
- [ ] Modelo `JobQueue` sin usar · `Video.rawUrl` sin usar
- [ ] `GET /videos` sin paginación · CORS abierto · LocalStack 2.3 antiguo
- [ ] Sin tests automatizados

**Siguiente paso concreto**

1. Pedir **API key de un LLM** al usuario.
2. Transcribir audio en el worker (`whisper.cpp` o API) → guardar en `Clip.transcript`.
3. Enviar transcripción + metadata al LLM → `score` 0-100 semántico + `Clip.title`/`hashtags`.

---

## 4. Decisiones técnicas clave

| Decisión | Motivo |
|---|---|
| Schema Prisma **único** en `/prisma/schema.prisma` | 3 schemas divergentes; nunca duplicar en `apps/*` |
| BullMQ v5 en ambos lados (`@nestjs/bullmq` v12 + `bullmq` v5) | API usaba bull v4, incompatible con el worker |
| `requestChecksumCalculation/responseChecksumValidation: 'WHEN_REQUIRED'` | AWS SDK v3 rompe LocalStack 2.3 (`x-amz-checksum-crc32` inválido) |
| `ebur128` en vez de `volumedetect` | `volumedetect` no da timestamps (todos los clips acababan en 0 s) |
| Regex `/t:\s*([\d.]+).*?M:\s*(-?[\d.]+)/` | ffmpeg 8 interpone `TARGET:-23 LUFS` entre `t:` y `M:` |
| `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920` | `crop=ih*9/16:ih` daba ancho impar → x264 fallaba |
| `-pix_fmt yuv420p` + `-movflags +faststart` | Compatibilidad navegador / player |
| `MAX_CLIPS = 10` + `MIN_HIGHLIGHT_SPACING = 15 s` | Videos largos generaban cientos de encodes |
| `dns: [8.8.8.8, 8.8.4.4]` en el worker | El resolver embebido `127.0.0.11` no resolvía hosts externos |
| `yt-dlp` + `python3`; `-f "bv*+ba/b" --merge-output-format mp4 -o <ruta>.mp4` | `-f best` en YouTube solo daba audio; sin extensión el archivo no coincidía con la ruta |
| Presignadas: sustituir `localstack:4566` → `localhost:4566` | El navegador del host no resuelve el host interno de Docker |
| Build context = raíz del repo; `npm ci` por app | Acceso al schema Prisma raíz + builds reproducibles |
| Bucket S3 idempotente en `onModuleInit` | El script init de LocalStack 2.3 no se ejecutaba siempre |
| `.env` fuera del repo · `.env.example` dentro | Repo público |
| Heurística = reglas, no IA | Sin dependencias de GPU/API; el "score viral" real requiere LLM |

---

## 5. Comandos

```powershell
docker compose up -d --build                      # levantar todo
docker compose ps                                 # estado
docker logs streamlike-worker-1 --tail 100        # log del worker
docker logs streamlike-api-1 --tail 100           # log de la API

# Rebuild obligatorio tras tocar el Dockerfile o el código del worker:
docker compose build worker
docker compose up -d --force-recreate worker

npm run prisma:migrate:deploy                    # aplicar migraciones
npm run build                                    # compilar web+api+worker
```

> Si el entorno se reinicia y Docker Desktop cae: los contenedores quedan
> `Exited (255)`; se recuperan con `docker compose up -d` (los volúmenes
> conservan PostgreSQL y LocalStack).
