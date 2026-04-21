import { Module } from '@nestjs/common';
import { CatsModule } from './http/cats.module';

@Module({
  imports: [CatsModule],
})
export class AppModule {}
