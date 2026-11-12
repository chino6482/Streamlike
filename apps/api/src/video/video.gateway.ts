import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { RedisService } from '../redis.service';

@WebSocketGateway({ cors: { origin: '*' } })
export class VideoGateway implements OnGatewayInit, OnGatewayConnection {
  @WebSocketServer()
  server: Server;

  constructor(private readonly redisService: RedisService) {}

  /** Rechaza la conexión si hay API_KEY configurada y no coincide. */
  handleConnection(client: Socket) {
    const expected = process.env.API_KEY;
    if (expected && client.handshake.auth?.apiKey !== expected) {
      client.disconnect(true);
    }
  }

  afterInit() {
    const subscriber = this.redisService.getClient().duplicate();
    subscriber.subscribe('video-status', (err) => {
      if (err) console.error('[Gateway] Redis subscribe error:', err);
    });

    subscriber.on('message', (channel, message) => {
      if (channel === 'video-status') {
        try {
          const payload = JSON.parse(message);
          this.server.emit('video-status', payload);
        } catch {
          this.server.emit('video-status', message);
        }
      }
    });
  }
}
