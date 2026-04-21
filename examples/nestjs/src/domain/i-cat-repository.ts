import type { Cat, CreateCatInput } from './cat.entity';

export interface ICatRepository {
  findAll(): Promise<Cat[]>;
  findById(id: string): Promise<Cat | null>;
  save(cat: Cat): Promise<void>;
  delete(id: string): Promise<void>;
}
