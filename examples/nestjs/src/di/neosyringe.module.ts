import { Module } from '@nestjs/common';
import { container } from './container';
import { CatsService } from '../domain/cats.service';

@Module({
  providers: [
    {
      provide: CatsService,
      useValue: container.resolve(CatsService),
    },
  ],
  exports: [CatsService],
})
export class NeoSyringeModule {}
