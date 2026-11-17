# AGENTS.md

## Entorno Local
- **Docker obligatorio**: El proyecto depende de `postgres`, `redis` y `localstack`. Sin Docker, las dependencias de red (BullMQ/Redis, S3/LocalStack) fallarán en el desarrollo local.
- **Arranque**: Usa `docker compose up -d --build`.
- **Desarrollo sin Docker**: Si no puedes usar Docker, necesitarás levantar manualmente los servicios de infraestructura (Postgres, Redis, LocalStack) en los puertos definidos en `README.md` (`5432`, `6379`, `4566`).

## Arquitectura
- **Monorepo**:
  - `apps/api/`: NestJS + Prisma + BullMQ + Socket.IO.
  - `apps/worker/`: Procesador de video (ffmpeg + yt-dlp).
  - `apps/web/`: Next.js.
- **Flujo de datos**: La API encola trabajos en Redis (BullMQ), que el `worker` consume para procesar videos.

## Comandos Útiles
- `npm run dev`: Inicia todos los servicios en desarrollo.
- `prisma generate`: Necesario si cambias el schema de base de datos.
- `prisma migrate deploy`: Aplica las migraciones (importante en despliegue).

## Notas Técnicas
- **LocalStack**: Utilizado para emular S3. Si `localstack` no es accesible desde el `worker` o la `api`, las subidas fallarán.
- **Variables de Entorno**: Verifica que `.env` coincida con las dependencias de los contenedores Docker si decides ejecutarlos manualmente.
