import * as dns from 'dns/promises';
import * as net from 'net';

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeUrlError';
  }
}

function ipv4ToInt(ip: string): number {
  return ip
    .split('.')
    .reduce((acc, oct) => ((acc << 8) | (parseInt(oct, 10) & 0xff)) >>> 0, 0);
}

function isPublicIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const n = ipv4ToInt(ip);
  const inRange = (cidrBase: string, maskBits: number) => {
    const base = ipv4ToInt(cidrBase);
    const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
    return (n & mask) === (base & mask);
  };

  if (inRange('0.0.0.0', 8)) return false;
  if (inRange('10.0.0.0', 8)) return false;
  if (inRange('100.64.0.0', 10)) return false;
  if (inRange('127.0.0.0', 8)) return false;
  if (inRange('169.254.0.0', 16)) return false;
  if (inRange('172.16.0.0', 12)) return false;
  if (inRange('192.0.0.0', 24)) return false;
  if (inRange('192.0.2.0', 24)) return false;
  if (inRange('192.168.0.0', 16)) return false;
  if (inRange('198.18.0.0', 15)) return false;
  if (inRange('198.51.100.0', 24)) return false;
  if (inRange('203.0.113.0', 24)) return false;
  if (inRange('224.0.0.0', 4)) return false;
  if (inRange('240.0.0.0', 4)) return false;
  return true;
}

export function isPublicIp(rawIp: string): boolean {
  const ip = rawIp.split('%')[0].trim().toLowerCase();
  const version = net.isIP(ip);
  if (version === 4) return isPublicIpv4(ip);
  if (version === 6) {
    if (ip === '::' || ip === '::1') return false;
    if (ip.startsWith('::ffff:')) {
      const embedded = ip.slice('::ffff:'.length);
      if (net.isIP(embedded) === 4) return isPublicIpv4(embedded);
    }
    if (ip.startsWith('fc') || ip.startsWith('fd')) return false;
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) {
      return false;
    }
    if (ip.startsWith('ff')) return false;
    return true;
  }
  return false;
}

export async function assertPublicUrl(rawUrl: string): Promise<string> {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new UnsafeUrlError('URL vacía o inválida');
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new UnsafeUrlError('Formato de URL inválido');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(`Esquema no permitido: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new UnsafeUrlError('Host interno o loopback bloqueado');
  }

  if (net.isIP(hostname) !== 0) {
    if (!isPublicIp(hostname)) {
      throw new UnsafeUrlError('Dirección IP privada o reservada bloqueada');
    }
    return parsed.toString();
  }

  try {
    const records = await dns.lookup(hostname, { all: true });
    if (!records || records.length === 0) {
      throw new UnsafeUrlError('No se pudo resolver el host');
    }
    for (const rec of records) {
      if (!isPublicIp(rec.address)) {
        throw new UnsafeUrlError(`El host ${hostname} resuelve a una IP no pública`);
      }
    }
  } catch (err) {
    if (err instanceof UnsafeUrlError) throw err;
    throw new UnsafeUrlError(`Error resolviendo el host: ${(err as Error).message}`);
  }

  return parsed.toString();
}

export function sanitizeStorageKey(rawKey: string): string {
  const cleaned = (rawKey || '').replace(/\0/g, '').trim();
  if (!cleaned || cleaned.includes('..') || cleaned.startsWith('/') || cleaned.startsWith('\\')) {
    throw new UnsafeUrlError('Nombre de archivo o clave S3 inválida');
  }
  return cleaned;
}
