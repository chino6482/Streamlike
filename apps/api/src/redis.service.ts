import { Injectable } from '@nestjs/common';
import * as dotenv from 'dotenv';
import { Redis } from 'ioredis';

dotenv.config();

@Injectable()
export class RedisService {
  private client: Redis;

  constructor() {
    // ioredis acepta directamente la URL `redis://host:port`
    this.client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');
  }

  getClient(): Redis {
    return this.client;
  }
}
