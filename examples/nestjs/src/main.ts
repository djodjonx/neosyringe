import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
  console.log('NeoSyringe + NestJS running on http://localhost:3000');
  console.log('Open http://localhost:3000 in your browser for the interactive UI');
}

bootstrap();
