import { Module } from '@nestjs/common';
import { CatsController } from './cats.controller';
import { NeoSyringeModule } from '../di/neosyringe.module';

@Module({
  imports: [NeoSyringeModule],
  controllers: [CatsController],
})
export class CatsModule {}
