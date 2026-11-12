# StreamLike 🎬

Monorepo de **clipping automático de video**: sube un video largo (o pega un
enlace) y un worker lo analiza para detectar los momentos de mayor energía y
generar **clips verticales 9:16** y **horizontales** listos para publicar.

> Estado: flujo completo verificado end-to-end (subida/enlace → cola → worker →
> clips → base de datos → web).

---

## ✨ Funcionalidades

- **Subida de video** por drag & drop (directo a S3 con URL prefirmada).
- **Procesado desde un enlace**: YouTube, TikTok, Instagram, X, Vimeo o un MP4
  directo (vía `yt-dlp` + ffmpeg).
- **Detección de momentos destacados** con una heurística multimodal:
  - **Audio (50 %)** — sonoridad por ventana (`ebur128`): gritos, risas, público.
  - **Habla (30 %)** — fracción de la ventana por encima del umbral de sonoridad.
  - **Acción (20 %)** — densidad de cortes de escena.
- **Clips automáticos** de 15 s en formato vertical (1080×1920) y horizontal.
- **Descarga del video completo** (opcional): se conserva el original en S3 y se
  descarga desde la web, no solo los clips.
- **Web en tiempo real** con Socket.IO (estado del procesamiento, progreso).
- **Borrado completo** de un video (objetos en S3 + registros en base de datos).

---

## 🏗️ Arquitectura

```
apps/
  api/     NestJS + Prisma + BullMQ + Socket.IO   -> http://localhost:3000
  worker/  Node + BullMQ + fluent-ffmpeg + yt-dlp (sin puerto)
  web/     Next.js 14 + Tailwind                  -> http://localhost:3001
prisma/
  schema.prisma            (schema canónico del monorepo)
  migrations/              (migraciones: 0_init, 1_add_video_source_fields)
docker-compose.yml         (postgres, redis, localstack, api, web, worker)
localstack/init/           (script de creación del bucket S3)
```

| Servicio | Puerto | Notas |
|---|---|---|
| PostgreSQL | 5432 | usuario `streamlike`, password `secret`, db `streamlike` |
| Redis | 6379 | cola BullMQ `video-processing` |
| LocalStack (S3) | 4566 | bucket `streamlike-bucket` |
| API | 3000 | |
| Web | 3001 | |

---

## 🚀 Arranque rápido

Requisitos: **Docker** + **Docker Compose**.

```bash
# 1. Variables de entorno (los valores por defecto son los de desarrollo local)
cp .env.example .env

# 2. Levantar todo (construye las imágenes)
docker compose up -d --build

# 3. Comprobar
docker compose ps
curl http://localhost:3000/          # -> "StreamLike API is running!"
open http://localhost:3001           # -> Web
```

La API aplica las migraciones de Prisma automáticamente al arrancar
(`prisma migrate deploy`).

---

## ⚙️ Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `DATABASE_URL` | `postgresql://streamlike:secret@postgres:5432/streamlike` | Conexión a PostgreSQL |
| `REDIS_URL` | `redis://redis:6379` | Cola BullMQ |
| `S3_ENDPOINT` | `http://localstack:4566` | Endpoint S3 (en prod: AWS) |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | `test` | Credenciales S3 |
| `S3_BUCKET` | `streamlike-bucket` | Bucket de clips y originales |
| `NEXT_PUBLIC_API_URL` | `http://localhost:3000` | URL de la API para el navegador (**build-time**) |
| `API_KEY` / `NEXT_PUBLIC_API_KEY` | *(desactivado)* | Si se define, la API exige la cabecera `x-api-key` |

> `NEXT_PUBLIC_*` se incrustan al compilar: si las cambias, hay que
> reconstruir la imagen (`docker compose build web && docker compose up -d web`).

---

## 🔌 API principal

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/videos` | Crea un video y lo encola. Acepta `s3Key` **o** `sourceUrl` (+ `keepOriginal`) |
| `GET` | `/videos` | Lista videos con sus clips |
| `GET` | `/videos/:id` | Detalle de un video |
| `GET` | `/videos/:id/download` | URL prefirmada para descargar el **video completo** |
| `DELETE` | `/videos/:id` | Borra el video, sus clips y los objetos en S3 |
| `POST` | `/upload/presign` | URL prefirmada para subir directo a S3 |

### Procesar desde un enlace

```bash
curl -X POST http://localhost:3000/videos \
  -H 'Content-Type: application/json' \
  -d '{
        "title": "mi-video",
        "s3Key": "https://www.youtube.com/watch?v=XXXX",
        "sourceUrl": "https://www.youtube.com/watch?v=XXXX",
        "keepOriginal": true
      }'
```

- `sourceUrl`: enlace de origen (YouTube/TikTok/MP4 directo).
- `keepOriginal`: guarda además el video completo en S3 para descargarlo.

---

## 🧠 Cómo se eligen los clips

1. `ebur128` devuelve la sonoridad (LUFS) por instante → se normaliza por ventana.
2. `select='gt(scene,0.3)'` detecta los cortes de escena → proxy de "acción".
3. Cada ventana de 15 s puntúa: `audio 50 % + habla 30 % + acción 20 %`.
4. Se eligen los mejores momentos (máx. 10, separados 15 s) y se codifican en
   vertical (1080×1920) y horizontal.

> Es una **heurística audiovisual**: no entiende el significado del discurso
> (sentimientos, "impacto psicológico"). Para eso haría falta transcripción
> (Whisper) + análisis semántico con un modelo de IA.

---

## 📁 Estructura

```
.
├── apps/api/          API REST + WebSocket + BullMQ + Prisma
├── apps/worker/       Consumidor de la cola: análisis ffmpeg + codificación
├── apps/web/          Frontend Next.js
├── prisma/            Schema canónico + migraciones
├── localstack/init/    Script de inicialización del bucket
├── docker-compose.yml
└── AI_HANDOFF.md      Documento de traspaso con el detalle de cambios y errores corregidos
```

---

## 🧪 Desarrollo local sin Docker (opcional)

```bash
npm install          # raíz (scripts de desarrollo)
npm run dev:api      # o dev:worker / dev:web
```

Requiere `ffmpeg` en el PATH (en Windows: `winget install ffmpeg`).

---

## 📄 Licencia

Proyecto de demostración. Sin licencia específica por ahora.
