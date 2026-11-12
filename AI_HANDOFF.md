# AI_HANDOFF — StreamLike

> **Documento de traspaso.** Registra **todo** lo que se modificó, los **errores
> corregidos** y el **estado en el que quedó** el proyecto, para que otra IA (o
> una persona) pueda continuar sin perder contexto.
>
> Fecha del traspaso: **2026-11-12**
> Autor de los cambios: sesión de agente anterior.
> Repositorio: `streamlike` (monorepo) — **publicado en GitHub**:
> https://github.com/chino6482/Streamlike (rama `main`, commit inicial `a0a5cd0`).

---

## 1. Resumen ejecutivo

StreamLike es un monorepo de "clipping" de video: se sube un video largo, un
worker lo analiza y genera clips verticales (9:16) y horizontales. Antes de esta
intervención **el flujo no funcionaba de punta a punta**: la subida a S3 fallaba,
el worker dejaba los videos colgados en `PROCESSING`, los clips verticales no se
podían codificar y el frontend mostraba información incompleta.

**Estado actual: el flujo completo funciona y está verificado end-to-end**
(subida → cola → worker → clips → base de datos → web).

Además, se puede **procesar directamente desde un enlace** (YouTube, TikTok o un
MP4 directo) gracias a `yt-dlp` + ffmpeg, y **descargar el video completo**
(opcionalmente conservado en S3), no solo los clips.

La pila completa corre con Docker Compose y los 6 contenedores están arriba y
sanos:

| Contenedor | Estado |
|---|---|
| `streamlike-postgres-1` | running (healthy) |
| `streamlike-redis-1` | running (healthy) |
| `streamlike-localstack-1` | running (healthy) |
| `streamlike-api-1` | running |
| `streamlike-worker-1` | running |
| `streamlike-web-1` | running |

---

## 2. Arquitectura y puertos

```
apps/
  api/     NestJS + Prisma + BullMQ + Socket.IO      -> http://localhost:3000
  worker/  Node + BullMQ + fluent-ffmpeg             -> (sin puerto)
  web/     Next.js 14 + Tailwind                     -> http://localhost:3001
prisma/
  schema.prisma        (schema CANÓNICO y canónico del monorepo)
  migrations/0_init/   (migración inicial)
docker-compose.yml     (postgres, redis, localstack, api, web, worker)
localstack/init/       (script de creación del bucket S3)
```

- **PostgreSQL** `5432` — usuario `streamlike`, password `secret`, db `streamlike`.
- **Redis** `6379`.
- **LocalStack (S3)** `4566` — bucket `streamlike-bucket`.
- **API** `3000`, **Web** `3001`.

---

## 3. Cómo levantar / verificar

```powershell
# 1. Construir y arrancar todo
docker compose up -d --build

# 2. Comprobar estado
docker compose ps
docker logs streamlike-api-1 --tail 50
docker logs streamlike-worker-1 --tail 50

# 3. Verificar buckets S3
docker exec streamlike-localstack-1 awslocal s3 ls
```

### Scripts de desarrollo (raíz `package.json`)

| Script | Qué hace |
|---|---|
| `npm run dev` | Levanta web + api + worker en paralelo |
| `npm run dev:web` / `dev:api` / `dev:worker` | Cada app por separado |
| `npm run build` | Compila web + api + worker |
| `npm run build:web` / `build:api` / `build:worker` | Compila una app |
| `npm run prisma:generate` | Genera el cliente Prisma |
| `npm run prisma:migrate:dev` | Crea/aplica migraciones en desarrollo |
| `npm run prisma:migrate:deploy` | Aplica migraciones pendientes |
| `npm run prisma:baseline` | Marca `0_init` como aplicada (baseline) |
| `npm run prisma:push` | Sincroniza el schema sin migración |

> **Nota Windows:** el `ffmpeg` del sistema debe estar en el PATH para correr el
> worker fuera de Docker. Dentro de Docker se instala con `apk add ffmpeg`.

---

## 4. Errores corregidos (detallado)

### 4.1 Procesamiento de video (worker)

Archivo principal: `apps/worker/src/worker.ts`.

1. **`InvalidRequest: Value for x-amz-checksum-crc32 header is invalid`** (bug
   crítico que rompía la subida de clips).
   El AWS SDK v3 reciente calcula checksums CRC32 por defecto, incompatibles con
   LocalStack 2.3. Se añadió en los clientes S3:
   ```ts
   requestChecksumCalculation: 'WHEN_REQUIRED',
   responseChecksumValidation: 'WHEN_REQUIRED',
   ```
   Aplicado en el worker **y** en la API (`upload.module.ts`).

2. **Los videos fallidos quedaban en `PROCESSING` para siempre.**
   El evento `failed` del worker solo notificaba por Redis; nunca actualizaba la
   base de datos. Ahora se persiste `status: 'FAILED'` en el handler
   `videoWorker.on('failed', ...)`.

3. **La detección de momentos destacados no funcionaba.**
   Se usaba `volumedetect`, que solo devuelve un máximo global **sin
   timestamps**, por lo que todos los clips acababan en el segundo 0. Se
   reemplazó por el filtro `ebur128`, parseando líneas
   `t: <seg> M: <LUFS>` para construir muestras `{time, loudness}` y elegir los
   instantes más ruidosos (`analyzeLoudness` + `pickHighlights`).

4. **Error de tipo: `duration` es `Int` en Prisma pero llegaba como float.**
   Se redondea con `Math.round(rawDuration)` antes de guardar.

5. **`width not divisible by 2` al codificar el clip vertical.**
   El filtro anterior `crop=ih*9/16:ih` producía un ancho impar. Se sustituyó
   por:
   ```
   scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920
   ```
   Resultado verificado: clips **1080x1920, h264**.

6. **Ruta temporal fija `/tmp` no multiplataforma.** Se usa `os.tmpdir()`.

7. **Detección de binarios ffmpeg/ffprobe.** `require('ffmpeg-static')` /
   `require('ffprobe-static')` envueltos en `try/catch`; si no están, cae al
   binario del PATH (imagen Docker). Se eliminó la dependencia
   `ffprobe-static` (~335 MB) porque el `ffprobe` de `apk add ffmpeg` funciona.

8. **Sin límite de clips.** Un video largo generaba cientos de encodes. Se añadió
   `MAX_CLIPS = 10` y separación mínima `MIN_HIGHLIGHT_SPACING = 15s`.

9. **Archivos temporales no se borraban.** Se añadieron bloques `try/finally`
   para limpiar tanto los clips como el video original descargado.

10. **Falta de compatibilidad del contenedor.** Se añadió `-pix_fmt yuv420p` y
    `-movflags +faststart`.

11. **Evento de estado con valor inexistente.** Se enviaba `status: 'DURATION'`,
    que no es un estado válido del enum. Ahora se mantiene `PROCESSING` y la fase
    informativa viaja aparte: `publishStatus({ status: 'PROCESSING', phase: 'DURATION' })`.

12. **Parseo de `REDIS_URL` frágil** (`.split(':')[2]`). Se centralizó en una
    función `parseRedisUrl()` dentro del worker.

### 4.2 API (`apps/api`)

1. **Incompatibilidad de colas: la API usaba `@nestjs/bull` (bull v4) y el worker
   `bullmq` v5.** Migración a `@nestjs/bullmq` (v12) en `app.module.ts`,
   `video.module.ts` y `video.service.ts` (`InjectQueue`). `bull` y
   `@nestjs/bull` ya no están en el árbol de dependencias.

2. **Parseo de `REDIS_URL` duplicado y frágil.** Se creó
   `apps/api/src/redis.config.ts` con `parseRedisUrl()` y se usó en
   `app.module.ts`. `RedisService` ahora pasa la URL directo a ioredis
   (`new Redis(process.env.REDIS_URL || 'redis://localhost:6379')`).

3. **No existía ninguna autenticación.** Se añadió un guard **opcional**
   `ApiKeyGuard` (`apps/api/src/common/api-key.guard.ts`) registrado globalmente
   en `main.ts`, y una comprobación en `VideoGateway.handleConnection()`. Se
   activa **solo** si la variable `API_KEY` está definida; si no, todo funciona
   igual que antes (modo desarrollo). Verificado: `401` sin cabecera, `200` con
   cabecera correcta.

4. **El bucket S3 no siempre existía** (el script de init de LocalStack no corría
   en 2.3). Se añadió `UploadService.onModuleInit()` que verifica con
   `HeadBucketCommand` y crea con `CreateBucketCommand` de forma idempotente.

5. **URL prefirmada apuntaba al host interno de Docker.** En
   `UploadService.createPresignedUrl()` se reemplaza `localstack:4566` por
   `localhost:4566` para que el navegador del usuario pueda subir.

6. **Faltaban dependencias** (`@nestjs/config`, `class-validator`) que impedían
   arrancar/validar. Se resolvieron al correr `npm install` en la raíz.

### 4.3 Frontend (`apps/web`)

1. **`fetchVideos` con closure obsoleto.** Se convirtió en `useCallback` y se
   corrigieron las dependencias de `useEffect` / `onDrop`.

2. **No enviaba API key.** Se añadieron las cabeceras `x-api-key` en las
   peticiones y `auth: { apiKey }` en la conexión Socket.IO.

3. **No mostraba la duración.** Se añadió `formatDuration()` (`m:ss`) en las
   tarjetas de video.

4. **No manejaba la fase ni el estado `FAILED`.** Ahora muestra "Midiendo la
   duración del video..." durante la fase `DURATION` y un mensaje claro para
   `FAILED`.

5. **Conflicto de peer-dependencies en `package.json`.** Tenía
   `@types/react@19` junto a `react-dom@18` y `typescript@7`. Se corrigió a
   `@types/react@^18`, `@types/node@^20` y `typescript@^5.4.2`.

6. **`yarn.lock` obsoleto** que contradecía el flujo npm. Eliminado (se usa
   `package-lock.json` + `npm ci`).

### 4.4 Prisma / base de datos

1. **Tres schemas Prisma divergentes** (`/prisma`, `apps/api/prisma`,
   `apps/worker/prisma`). Se consolidó en un único
   `prisma/schema.prisma` canónico y se **eliminaron** `apps/api/prisma` y
   `apps/worker/prisma`.

2. **No había migraciones.** Se generó la migración inicial
   `prisma/migrations/0_init/migration.sql` + `prisma/migrations/migration_lock.toml`.

3. **La base de datos ya tenía tablas** creadas con `db push`, por lo que
   `migrate deploy` fallaba. Se hizo **baseline**:
   `prisma migrate resolve --applied 0_init`. Ahora la API corre
   `npx prisma migrate deploy` al arrancar y reporta
   "No pending migrations to apply.".

4. Se fijó `binaryTargets = ["native", "linux-musl-openssl-3.0.x"]` para que el
   cliente Prisma funcione en Alpine (Docker) y en Windows (dev).

### 4.5 Docker / infraestructura

1. **Contexto de build por app impedía acceder al schema Prisma de la raíz.** Se
   cambió el contexto a la raíz del repo (`.`) para api, worker y web.

2. **Builds no reproducibles** (`npm install`). Se generaron `package-lock.json`
   por app y los Dockerfiles usan `npm ci`.

3. **`ffmpeg-static` / `ffprobe-static` innecesarios en Docker.** La imagen del
   worker instala `ffmpeg` con `apk`; el código cae al binario del PATH.

4. **Ruta de init de LocalStack incorrecta para 2.3.** Se cambió
   `./localstack/init:/docker-entrypoint-initaws.d` por
   `./localstack/init:/etc/localstack/init/ready.d`. Verificado en logs:
   `Running READY script ... 01-create-bucket.sh` → `make_bucket`.

5. **Los datos S3 se perdían al recrear LocalStack.** Se añadió el volumen
   `localstack_data:/var/lib/localstack`.

6. **Faltaba `.dockerignore`** (se copiaban `node_modules`, `.next`, `.env` al
   contexto). Creado en la raíz.

7. **`.env` incompleto.** Se añadió `NEXT_PUBLIC_API_URL` y documentación de
   `API_KEY`.

8. **`package.json` raíz sin scripts de worker/build.** Se añadieron
   `dev:worker`, `build:*` y los `prisma:*`.

### 4.6 Errores y cambios introducidos en esta sesión (2026-11-11)

1. **`ebur128` no producía muestras** (bug que hacía que TODAS las puntuaciones de
   clip fueran 0 o el fallback).
   Con ffmpeg 8 el filtro imprime `TARGET:-23 LUFS` **entre** `t:` y `M:`:
   ```
   [Parsed_ebur128_0 @ ...] t: 0.4  TARGET:-23 LUFS  M:-48.0 S:-120.7  I: -48.0 LUFS  LRA: 0.0 LU
   ```
   El regex antiguo `/t:\s*([\d.]+)\s+M:\s*(-?[\d.]+)/` no casaba. Se sustituyó por:
   `/t:\s*([\d.]+).*?M:\s*(-?[\d.]+)/`.

2. **Piso de silencio EBU R128**: se aplica `Math.max(loudness, -70)` para no
   tratar el silencio digital (-120 LUFS) como "alto".

3. **`docker compose build` no reemplaza el contenedor en ejecución** con el source
   actual (el worker siguió corriendo con un bundle viejo: regex antiguo, sin debug).
   Solución: `docker compose build --no-cache` + `docker compose up -d --force-recreate <svc>`.

4. **Detección de cortes (`analyzeScenes`)**: `select='gt(scene,0.3)',showinfo`.
   Detecta transiciones de escena como proxy de "acción".

5. **Log de observabilidad**: `[Worker] <videoId>: N highlights -> ...`.

6. **Nuevo endpoint de borrado**: `DELETE /videos/:id` (borra objetos S3 + jobs +
   clips + video). Verificado con HTTP 200 y la eliminación de registros en BD.

7. **Frontend**: UI modernizada (glassmorphism, gradientes, stats, toasts, modal de
   confirmación) + botón de eliminar + `DELETE` en página.

8. **Señal de habla en la heurística** (nueva): se añadió el componente "habla" con
   umbral `SPEECH_THRESHOLD_LUFS = -40` (LUFS). El score final ahora combina:
   audio (50 %) + habla (30 %) + acción (20 %).

9. **Capacidad de procesar desde enlace (URL)** (nueva): se añadió `sourceUrl` al
   job de worker y a la API.
   - Worker: si `job.data.sourceUrl` existe, descarga el video desde la URL con
     `ffmpeg(sourceUrl)` → temp file → pipeline existente (duración, highlights,
     clips, upload). Si no, descarga desde S3 (flujo previo).
   - API: `CreateVideoDto.sourceUrl?` opcional; `VideoService.create` guarda
     `s3Key = sourceUrl || s3Key` y propaga `sourceUrl` en el job.
   - Web: input `type="url"` + botón "Procesar" → `POST /videos` con `sourceUrl`.

10. **Restauración de DNS del container** (worker): se añadió `dns: [8.8.8.8, 8.8.4.4]`
    al servicio `worker` en `docker-compose.yml`. Resultado: el worker vuelve a
    resolver hosts externos (`google.com` OK) y mantiene la resolución interna de
    los servicios de compose (`redis`, `postgres`, `localstack`). Con esto, el
    `ffmpeg` con entrada HTTP ya puede descargar videos desde enlaces.

### 4.7 YouTube / TikTok con `yt-dlp` y descarga del video completo

11. **YouTube/TikTok no se podían procesar** (ffmpeg solo admite URLs directas a
    archivo). Se añadió **`yt-dlp`** al worker:
    - `apps/worker/Dockerfile`: `apk add ... curl ca-certificates python3` +
      descarga del binario `yt-dlp` a `/usr/local/bin/yt-dlp`.
    - `apps/worker/src/worker.ts`: nueva función `downloadSource()` que decide:
      - URL de plataforma (youtube, youtu.be, tiktok, instagram, twitter/x,
        vimeo, ok.ru) → `yt-dlp`.
      - URL directa a archivo → `ffmpeg` por HTTP.

12. **`yt-dlp` fallaba con `env: can't execute 'python3'`**: el binario descargado
    es un script de Python. Se instaló `python3` en la imagen. Verificado:
    `yt-dlp --version` → `2026.10.26`.

13. **`-f best` no encontraba formato en YouTube** (`Requested format is not
    available`): `-f best` elige el formato *pre-mergeado* (en YouTube solo
    había audio). Se cambió a `-f "bv*+ba/b" --merge-output-format mp4`
    (mejor vídeo + mejor audio, fusionado a MP4).

14. **El archivo descargado no coincidía con la ruta esperada** (job en `FAILED`
    con `ffprobe exited with code 1` → `No such file or directory`):
    `-o /tmp/x` sin extensión produce `/tmp/x.webm`, pero el worker pasaba
    `/tmp/x` a ffprobe. Solución: el nombre temporal ahora incluye la
    extensión (`<videoId>-source.mp4`) y se usa `--merge-output-format mp4`.

15. **Descarga del video COMPLETO desde el enlace** (nueva): además de los
    clips, se puede conservar el video original para descargarlo.
    - **Schema**: `Video.sourceUrl` (enlace de origen) y `Video.originalKey`
      (clave S3 del video completo). Migración
      `prisma/migrations/1_add_video_source_fields/migration.sql`.
    - **API**: `CreateVideoDto.keepOriginal?: boolean`; el job del worker lo
      recibe; `GET /videos/:id/download` devuelve una **URL prefirmada**
      (15 min) del video completo, con el host interno sustituido
      (`localstack:4566` → `localhost:4566`) para que el navegador la use.
      `DELETE /videos/:id` ahora borra también el objeto original.
    - **Worker**: si `keepOriginal` es `true`, sube el archivo descargado a
      `originals/<videoId>/original.mp4` y guarda `originalKey` en la BD. Si
      falla, el pipeline de clips continúa (no es crítico).
    - **Web**: checkbox "Guardar el video completo" en el bloque de enlaces
      (activo por defecto) + botones "Descargar video completo" en la tarjeta
      y en el detalle del video.

---

## 5. Archivos modificados / creados

### Creados

| Archivo | Propósito |
|---|---|
| `AI_HANDOFF.md` | Este documento |
| `.dockerignore` | Excluye `node_modules`, `dist`, `.next`, `.env`, etc. del contexto |
| `prisma/migrations/0_init/migration.sql` | Migración inicial del schema |
| `prisma/migrations/1_add_video_source_fields/migration.sql` | Añade `Video.sourceUrl` y `Video.originalKey` (video completo descargable) |
| `prisma/migrations/migration_lock.toml` | Lock de migraciones (postgresql) |
| `apps/api/src/redis.config.ts` | `parseRedisUrl()` compartido |
| `apps/api/src/s3/s3.module.ts` | Módulo global S3 (`S3_CLIENT`, `createS3Client`) compartido entre apps |
| `apps/api/src/common/api-key.guard.ts` | Guard opcional por API key |
| `apps/api/package-lock.json` | Lockfile reproducible |
| `apps/worker/package-lock.json` | Lockfile reproducible |
| `apps/web/package-lock.json` | Lockfile reproducible |

### Modificados

| Archivo | Cambio |
|---|---|
| `apps/worker/src/worker.ts` | Todos los arreglos de video (checksum, ebur128, crop, tmpdir, FAILED, MAX_CLIPS, limpieza, pix_fmt, fases) + heurística multimodal (audio/habla/acción) + `downloadSource()` con `yt-dlp` + guardado del video completo (`keepOriginal`) |
| `apps/worker/Dockerfile` | `ffmpeg` + `curl`/`ca-certificates` + `python3` + binario `yt-dlp` |
| `apps/api/src/app.module.ts` | `@nestjs/bullmq` + `parseRedisUrl` + `S3Module` |
| `apps/api/src/video/video.module.ts` | `@nestjs/bullmq` + `S3Module` |
| `apps/api/src/video/video.service.ts` | `InjectQueue` de `@nestjs/bullmq` + `S3Client` + `remove()` (borrado, incluye el original) + `getDownloadUrl()` (URL prefirmada del video completo) |
| `apps/api/src/video/video.controller.ts` | Endpoints `DELETE /videos/:id` y `GET /videos/:id/download` |
| `apps/api/src/video/dto/create-video.dto.ts` | `sourceUrl?` y `keepOriginal?` |
| `apps/api/src/video/video.gateway.ts` | `OnGatewayConnection` + validación de API key |
| `apps/api/src/main.ts` | `useGlobalGuards(new ApiKeyGuard())` |
| `apps/api/src/redis.service.ts` | URL directa a ioredis |
| `apps/api/src/upload/upload.module.ts` | `S3Module` |
| `apps/api/src/upload/upload.service.ts` | `S3_CLIENT` + `onModuleInit` (bucket) + host en presign |
| `apps/web/app/page.tsx` | `useCallback`, API key, duración, fase, FAILED, stats, toast, modal, eliminar, procesar desde enlace, checkbox "Guardar el video completo" y botón "Descargar video completo" |
| `apps/web/app/layout.tsx` | Header/footer modernos |
| `apps/web/app/globals.css` | Aurora, scrollbar, animaciones |
| `apps/web/package.json` | Versiones de tipos/TS corregidas |
| `apps/api/package.json`, `apps/worker/package.json` | AWS SDK fijado a `3.1166.0`, `@nestjs/bullmq`, `ffprobe-static` fuera |
| `package.json` (raíz) | Scripts nuevos |
| `docker-compose.yml` | Contextos raíz, args del web, init + persistencia de LocalStack |
| `.env` | `NEXT_PUBLIC_API_URL`, documentación de `API_KEY` |
| `prisma/schema.prisma` | Schema único canónico + `sourceUrl` / `originalKey` en `Video` |

### Eliminados

| Ruta | Motivo |
|---|---|
| `apps/api/prisma/` | Schema duplicado (se consolidó en la raíz) |
| `apps/worker/prisma/` | Schema duplicado |
| `apps/web/yarn.lock` | Lockfile obsoleto; el proyecto usa npm |
| `apps/web/tsconfig.tsbuildinfo` | Artefacto de compilación |

---

## 6. Verificación realizada (end-to-end)

1. **Compilación:** `tsc --noEmit` pasa en `api`, `worker` y `web`.
2. **Imágenes Docker:** las 3 (`api`, `worker`, `web`) se construyen con
   contexto raíz y `npm ci`.
3. **Arranque:** `docker compose up -d --force-recreate` OK; la API loguea
   "No pending migrations to apply.".
4. **Bucket S3:** el script de init de LocalStack crea `streamlike-bucket`
   (verificado en logs y con `awslocal s3 ls`).
5. **Flujo completo:** se generó un video de prueba de 40s con ffmpeg, se obtuvo
   URL prefirmada → `PUT` a LocalStack (`HTTP 200`) → `POST /videos` → el worker
   procesó y creó **clips**, video en `COMPLETED` con `duration = 40`.
6. **Clip vertical:** descargado de S3 y verificado con `ffprobe` →
   `codec_name=h264`, `width=1080`, `height=1920`.
7. **Web:** responde `HTTP 200` en `http://localhost:3001`.
8. **API key:** con `API_KEY` activada, `GET /videos` devuelve `401` sin cabecera
   y `200` con `x-api-key`. Luego se **desactivó** por defecto.

> Datos de prueba que pueden existir en la base: un video
> `abb54664-1e3d-4199-997d-6b61dfa508da` (`COMPLETED`, 2 clips).

### 6.1 Verificación de esta sesión (2026-11-11) — UI, borrado y análisis

1. **Nuevo endpoint DELETE:** `DELETE /videos/:id` → HTTP 200; el video y sus clips
   desaparecen de PostgreSQL (se comprobó con `SELECT count(*)`).
2. **UI web:** el bundle (`/app/.next/server/app/page.js`) contiene la nueva UI
   ("clips virales", "Eliminar video") → desplegada y respondiendo HTTP 200.
3. **Worker con fixes:** se generó un video de prueba (40s, cortes en 10/20/30 s,
   audio con volúmenes variables) → el análisis devolvió:
   ```
   [Worker] cc65feb5-...: 2 highlights -> 10s(score 65), 25s(score 63)
   ```
   y creó clips `VERTICAL`/`HORIZONTAL` en [10, 25] (score 65) y [25, 40] (score 63).
   → **El audio (`ebur128`) ya se está puntuando correctamente**.
4. **Alerta**: hubo que usar `docker compose build --no-cache` + `docker compose up -d --force-recreate`
   para que el contenedor del worker adoptara el código nuevo. Sin `--force-recreate`
   el contenedor no se reemplaza aunque el build tenga éxito.
5. **Señal de habla:** se añadió el componente de habla al score (audio 50 % + habla
   30 % + acción 20 %). Con el mismo video de prueba:
   ```
   [Worker] fb5f4513-...: 2 highlights -> 10s(score 79), 25s(score 77)
   ```
   clips con scores 79 y 77. El pipeline multimodal quedó verificado.

### 6.2 Verificación de la última sesión — enlaces (YouTube/TikTok) + video completo

1. **`yt-dlp` instalado y operativo** en el contenedor del worker:
   `yt-dlp --version` → `2026.10.26` (requiere `python3`, instalado en la imagen).
2. **Descarga con YouTube verificada**: `yt-dlp -f "bv*+ba/b" --merge-output-format mp4`
   descargó y fusionó correctamente (634 s, 722 MB) y `ffprobe` lo leyó sin error.
   TikTok también: descarga de 1.9 MB correcta.
3. **E2E completo con enlace (YouTube)**: `POST /videos` con
   `sourceUrl=https://www.youtube.com/watch?v=aqz-KE-bpKQ` → el worker descargó,
   analizó y generó **24 clips** → estado `COMPLETED`, `duration = 635`.
4. **E2E con "Guardar el video completo"** (`keepOriginal: true`):
   - `originalKey = originals/<videoId>/original.mp4` persistido en la BD ✅
   - Objeto en LocalStack: `original.mp4` (20.4 MB) ✅
   - `GET /videos/:id/download` → devuelve URL prefirmada (15 min) con el host
     corregido a `localhost:4566` ✅
   - Descarga real desde el host: **HTTP 206 Partial Content**, `video/mp4` ✅
   - `DELETE /videos/:id` → borró **20 objetos** de S3 (18 clips + original +
     clave del video) y el directorio `originals/...` quedó vacío ✅
5. **Migración aplicada**: la API loguea
   `Applying migration 1_add_video_source_fields` → `All migrations have been
   successfully applied`.
6. **Web**: el HTML servido contiene "Guardar el video completo" y el bundle
   contiene `keepOriginal` y "Descargar video completo" ✅
7. **Reinicio del entorno**: Docker Desktop se apagó y todos los contenedores
   quedaron `Exited (255)`. Se recuperó con `Start-Process "...\Docker Desktop.exe"`
   + `docker compose up -d`. Los volúmenes (PostgreSQL, LocalStack) conservaron
   los datos.

---

## 7. Pendientes / deuda técnica

1. **Autenticación completa (JWT + roles).** El modelo `User` tiene `roles` y
   `plan_subscription`, pero no se usan. El `ApiKeyGuard` es una protección
   mínima de "defensa en profundidad", desactivada por defecto.

2. **Modelo `JobQueue` sin usar.** Existe en el schema pero la cola real es
   BullMQ/Redis; se podría eliminar o conectar.

3. **`API_KEY` desactivada por defecto** en `.env` (solo hay que descomentarla).
   Al activarla, **reconstruir el contenedor web** para incrustar
   `NEXT_PUBLIC_API_KEY`:
   `docker compose build web && docker compose up -d web`.

4. **CORS abierto** (`origin: '*'` y `app.enableCors()` sin restringir). Aceptable
   para el prototipo, no para producción.

5. **LocalStack 2.3 es antiguo.** Actualizar a una versión moderna permitiría
   quitar los flags `WHEN_REQUIRED`, pero se evitó por riesgo (auth-token /
   healthcheck). Decisión consciente.

6. **`ffmpeg-static` sigue como dependencia** (útil en dev sobre Windows); en
   Docker no se usa. Se podría mover a `optionalDependencies`.

7. **`rawUrl` en `Video` sin usar.**

8. **Sin tests automatizados** (unitarios/integración).

9. **Sin paginación** en `GET /videos` (devuelve todo).

10. **El `score` de los clips ya no es un placeholder**: la heurística (audio ebur128 +
    habla + acción) lo calcula y persiste como 0..100. La "puntuación viral con IA" (LLM
    sobre el contenido hablado) sigue pendiente.

11. **Análisis semántico real (pendiente)**: la heurística actual cubre "euforia"
    (audio), "habla" y "acción" (cortes/escena), pero NO entiende el contenido
    hablado (sentimientos reales, "impacto psicológico") ni el contexto semántico.
    Para eso haría falta transcripción (Whisper) + análisis semántico/ViT. Ver
    sección 6.1.

12. **Alineación de versiones `socket.io`/`socket.io-client`: ambos en `^4.7.5`,
    correcto; vigilar que no se desalineen en el futuro.

13. **Repositorio bajo git desde 2026-11-12**: se inicializó git, se añadió
    `.gitignore` + `.env.example` (el `.env` real **nunca** se sube) y se publicó
    en `https://github.com/chino6482/Streamlike` (público, rama `main`).
    Pendiente: configurar CI (build + typecheck) y añadir licencia.

14. **Procesar desde enlace (URL)**: ✅ **verificado e2e** (ver §6.2). Ya no está
    pendiente. Recordar que el worker necesita **DNS saliente** (está fijado a
    `8.8.8.8/8.8.4.4` en `docker-compose.yml`).

15. **Sin límite de tamaño/tiempo de descarga**: un enlace puede apuntar a un
    video de varios GB (se descargó uno de 722 MB) y el temp + la copia en S3
    consumen disco. Pendiente: límite configurable (p. ej. `MAX_SOURCE_MB`) y
    aviso en la UI.

16. **Copia del video completo = doble almacenamiento**: cuando `keepOriginal`
    está activo se guarda el original en S3 además de los clips. En producción
    conviene un bucket aparte o una regla de expiración (Lifecycle).

17. **URLs prefirmadas de 15 min** para la descarga: si el video es grande, el
    navegador puede cortar la descarga al expirar la firma. Para archivos >1 GB
    conviene firmar más tiempo o usar descarga por partes.

18. **`yt-dlp` sin JS runtime (deno)**: YouTube funciona, pero algunas
    extracciones nuevas de YouTube requieren un runtime JS. Se puede instalar
    `deno` en la imagen del worker si empiezan a fallar formatos.

---

## 8. Notas para la siguiente IA

- El **bug raíz** era la incompatibilidad de checksums CRC32 del AWS SDK con
  LocalStack 2.3; si en algún momento reaparece un `InvalidRequest` de checksum,
  revisar los flags `requestChecksumCalculation` / `responseChecksumValidation`
  en `apps/worker/src/worker.ts` y `apps/api/src/upload/upload.module.ts`.
- El **schema Prisma es único** (`/prisma/schema.prisma`). **No** recrear schemas
  dentro de `apps/*`.
- La **cola** es BullMQ (`video-processing`); API y worker deben usar la misma
  versión de `bullmq` (hoy `^5`).
- Al tocar `NEXT_PUBLIC_*`, recordar que son variables de **build-time**: hay que
  reconstruir la imagen `web`.
- Para depurar: `docker logs streamlike-worker-1 --tail 100` y
  `docker logs streamlike-api-1 --tail 100`.
- **Procesado desde enlaces**: el worker usa `yt-dlp` para plataformas
  (YouTube/TikTok/Instagram/X/Vimeo) y ffmpeg HTTP para URLs directas. Si se
  toca el `Dockerfile` del worker hay que **reconstruir la imagen**
  (`docker compose build worker && docker compose up -d worker`): cambiar el
  Dockerfile no afecta al contenedor ya creado.
- **Descarga del video completo**: se activa con `keepOriginal: true` en
  `POST /videos` (checkbox "Guardar el video completo" en la web). El original
  se guarda en `originals/<videoId>/original.mp4` y se descarga con
  `GET /videos/:id/download` (URL prefirmada de 15 min).

---

