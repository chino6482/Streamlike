# StreamLike 🎬

Monorepo de **clipping automático de video con IA**: sube un video largo (o pega un
enlace) y StreamLike detecta los momentos de mayor retención viral usando
**Gemini 3** (`gemini-3-flash-preview`) o respaldo heurístico audiovisual, quema
subtítulos `.ass` dinámicos y genera **clips verticales 9:16** y **horizontales**
listos para publicar.

---

## ✨ Funcionalidades

- **Análisis multimodal con Gemini 3 + modo BYOK**:
  - Extrae una pista de audio ligera (`.mp3` mono 16 kHz) y analiza el contenido con
    `gemini-3-flash-preview` usando *Structured Outputs* para obtener clips de
    20–55s con `title`, `viralScore` (1–100), `hookReason` y `transcript`.
  - **Modo BYOK (Bring Your Own Key)**: cada usuario puede configurar su propia
    `Gemini API Key` en **Configuración de API Keys** (persistida solo en el
    `localStorage` del navegador y enviada por petición en la cabecera
    `x-gemini-key`, sin guardarse en la base de datos).
  - **Fallback automático**: si no hay clave (ni en el navegador ni en
    `GEMINI_API_KEY` del servidor) o la API falla, el pipeline recurre a la
    heurística `ebur128` (sonoridad + habla) y detección de cortes de escena.
- **Subtítulos `.ass` dinámicos en vertical (`1080×1920`)**:
  - Bloques cortos de 3–4 palabras sincronizados con estilo moderno en negrita
    (`DejaVu Sans`, borde negro grueso, sombra suave y posición segura en el
    tercio inferior `MarginV=380`).
- **Reencuadre inteligente 9:16** (`AUTO`, `VERTICAL_CROP`, `BLUR_FILL`,
  `SPLIT` para podcasts y `SCREENCAST`).
- **Procesado desde enlace o archivo**: YouTube, TikTok, Instagram, X, Vimeo o MP4
  directo (vía binario nativo `yt-dlp_linux` + FFmpeg + protección SSRF).
- **Almacenamiento S3 universal**: compatible con **LocalStack**, **Cloudflare R2**
  y **Supabase Storage** sin cambios en el código (`forcePathStyle: true` y
  `AWS_REGION=auto`).

---

## 🏗️ Arquitectura

```
apps/
  api/     NestJS + Prisma + BullMQ + Socket.IO   -> http://localhost:3000
  worker/  Node 22 + BullMQ + FFmpeg/libass + yt-dlp_linux + @google/genai
  web/     Next.js 14 + Tailwind                  -> http://localhost:3001
prisma/
  schema.prisma            (schema canónico del monorepo + campos IA en Clip)
  migrations/              (0_init, 1_add_video_source_fields, 2_add_clip_ai_fields)
docker-compose.yml         (postgres, redis, localstack, api, web, worker)
```

---

## 🚀 Arranque rápido con Docker

Requisitos: **Docker** + **Docker Compose**.

```bash
# 1. Crear archivo de entorno
cp .env.example .env
# Rellena DATABASE_URL, REDIS_URL y credenciales S3 (ver tabla inferior)

# 2. Construir (usa oven/bun:1-slim para dependencias cacheadas + Node 22 slim en runtime)
docker compose up -d --build

# 3. Comprobar servicios
docker compose ps
curl http://localhost:3000/          # -> "StreamLike API is running!"
```

La API ejecuta `prisma migrate deploy` automáticamente al arrancar.

---

## ⚙️ Variables de entorno

| Variable | Ejemplo / Por defecto | Descripción |
|---|---|---|
| `DATABASE_URL` | `postgresql://streamlike:secret@postgres:5432/streamlike` | Conexión a PostgreSQL |
| `REDIS_URL` | `redis://redis:6379` | Cola BullMQ |
| `AWS_REGION` | `auto` | Región S3 (`auto` requerido para Cloudflare R2; válido en LocalStack/Supabase) |
| `S3_ENDPOINT` | `http://localstack:4566` | Endpoint S3 interno (LocalStack, R2 o Supabase S3) |
| `S3_PUBLIC_ENDPOINT` | `http://localhost:4566` | Dominio público para servir los clips (`r2.dev`, Supabase public URL o LocalStack) |
| `S3_FORCE_PATH_STYLE` | `true` | Mantiene URLs path-style (`true` por defecto para LocalStack, R2 y Supabase) |
| `S3_BUCKET` | `streamlike-bucket` | Bucket de clips y videos originales |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` | Credenciales del proveedor S3 |
| `GEMINI_API_KEY` | *(vacío / opcional)* | Clave de respaldo en servidor si el cliente no envía `x-gemini-key` (BYOK) |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | URL de la API para el navegador (**build-time**) |
| `API_KEY` / `NEXT_PUBLIC_API_KEY` | *(desactivado)* | Cabecera opcional `x-api-key` |

---

## ☁️ Configuración para Cloudflare R2 y Supabase Storage

### Cloudflare R2

1. Crea un bucket en Cloudflare R2 y habilita acceso público (`r2.dev` o dominio propio).
2. Genera un token S3 (Access Key ID + Secret Access Key) y configura `.env`:

```env
AWS_REGION=auto
S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
S3_PUBLIC_ENDPOINT=https://pub-<PUBLIC_HASH>.r2.dev
S3_BUCKET=streamlike-clips
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<R2_ACCESS_KEY_ID>
AWS_SECRET_ACCESS_KEY=<R2_SECRET_ACCESS_KEY>
```

> StreamLike detecta automáticamente dominios `*.r2.dev` y rutas públicas de Supabase
> para no duplicar el nombre del bucket en la URL final del clip.

### Supabase Storage (S3 Protocol)

```env
AWS_REGION=<TU_REGION_SUPABASE>
S3_ENDPOINT=https://<PROJECT_REF>.supabase.co/storage/v1/s3
S3_PUBLIC_ENDPOINT=https://<PROJECT_REF>.supabase.co/storage/v1/object/public/<BUCKET>
S3_BUCKET=<BUCKET>
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=<SUPABASE_S3_ACCESS_KEY>
AWS_SECRET_ACCESS_KEY=<SUPABASE_S3_SECRET_KEY>
```

---

## 🧠 Modo BYOK (Bring Your Own Key) vs `GEMINI_API_KEY`

- **En el navegador (BYOK)**: abre **Configuración de API Keys**, pega tu clave de
  [Google AI Studio](https://aistudio.google.com/) y guárdala. Se almacena
  únicamente en `localStorage` (`GEMINI_API_KEY`) y el frontend la envía por
  petición en la cabecera HTTP `x-gemini-key`. La API la reenvía de forma efímera
  al worker en BullMQ sin guardarla en PostgreSQL.
- **En el servidor (respaldo)**: define `GEMINI_API_KEY` en `.env` si quieres
  habilitar Gemini 3 también cuando un usuario no haya configurado clave propia.
- **Sin clave**: el sistema sigue funcionando con la heurística `ebur128` + escenas.

---

## 🧪 Desarrollo local y verificación

```bash
bun install
npm run dev          # Frontend Next.js en http://localhost:3000
npm run dev:api      # API NestJS
npm run dev:worker   # Worker de procesamiento
```

Verificación de tipos y compilación:

```bash
./apps/api/node_modules/.bin/tsc -p apps/api/tsconfig.json --noEmit
./apps/worker/node_modules/.bin/tsc -p apps/worker/tsconfig.json --noEmit
./apps/web/node_modules/.bin/tsc -p apps/web/tsconfig.json --noEmit
```
