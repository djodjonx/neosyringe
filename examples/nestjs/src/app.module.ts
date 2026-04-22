import { Module } from '@nestjs/common';
import { CatsModule } from './http/cats.module';
import { AppController } from './http/app.controller';

@Module({
  imports: [CatsModule],
  controllers: [AppController],
})
export class AppModule {}
