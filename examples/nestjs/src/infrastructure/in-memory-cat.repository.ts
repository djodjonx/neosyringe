import type { Cat } from '../domain/cat.entity';
import type { ICatRepository } from '../domain/i-cat-repository';

export class InMemoryCatRepository implements ICatRepository {
  private store = new Map<string, Cat>();

  async findAll(): Promise<Cat[]> {
    return [...this.store.values()];
  }

  async findById(id: string): Promise<Cat | null> {
    return this.store.get(id) ?? null;
  }

  async save(cat: Cat): Promise<void> {
    this.store.set(cat.id, cat);
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }
}
