import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { ApiKeyGuard } from './common/api-key.guard';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  // Protección opcional por API key (activa solo si API_KEY está definida)
  app.useGlobalGuards(new ApiKeyGuard());
  const port = process.env.PORT || 3000;
  app.enableCors();
  await app.listen(port);

  console.log(`API listening on http://localhost:${port}`);
}
bootstrap();
