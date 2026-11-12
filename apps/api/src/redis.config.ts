/**
 * Parsea una URL de Redis (`redis://host:port`) a las opciones de conexión que
 * espera BullMQ. Antes esta lógica estaba duplicada y era frágil en varios
 * archivos (app.module, video.service, worker).
 */
export function parseRedisUrl(url?: string): { host: string; port: number } {
  const raw = (url || 'redis://localhost:6379').replace(/^rediss?:\/\//, '');
  const [host, port] = raw.split(':');
  return {
    host: host || 'localhost',
    port: Number(port) || 6379,
  };
}
