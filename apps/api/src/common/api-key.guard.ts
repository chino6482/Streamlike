import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

/**
 * Guard de API key opcional.
 *
 * - Si la variable de entorno `API_KEY` NO está definida, no se exige nada
 *   (modo desarrollo, comportamiento previo).
 * - Si `API_KEY` está definida, toda petición HTTP debe enviar la cabecera
 *   `x-api-key` con el mismo valor.
 *
 * NOTA: esto es una protección mínima (defensa en profundidad) para el
 * prototipo. Un esquema completo de usuarios/roles con JWT queda pendiente
 * (ver AI_HANDOFF.md).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expected = process.env.API_KEY;
    if (!expected) return true;

    const request = context.switchToHttp().getRequest();
    const provided =
      request.headers['x-api-key'] || request.headers['X-API-KEY'];

    if (provided !== expected) {
      throw new UnauthorizedException('API key inválida o ausente');
    }
    return true;
  }
}
