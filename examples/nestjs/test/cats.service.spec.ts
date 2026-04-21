import { describe, it, expect, beforeEach } from 'vitest';
import { CatsService } from '../src/domain/cats.service';
import type { ICatRepository } from '../src/domain/i-cat-repository';
import type { Cat } from '../src/domain/cat.entity';

// Minimal in-memory stub — no mocking framework needed
class StubCatRepository implements ICatRepository {
  private store: Cat[] = [];

  async findAll(): Promise<Cat[]> { return [...this.store]; }
  async findById(id: string): Promise<Cat | null> {
    return this.store.find(c => c.id === id) ?? null;
  }
  async save(cat: Cat): Promise<void> { this.store.push(cat); }
  async delete(id: string): Promise<void> {
    this.store = this.store.filter(c => c.id !== id);
  }
}

describe('CatsService', () => {
  let service: CatsService;

  beforeEach(() => {
    // Direct instantiation — no TestingModule, no bootstrap, instant
    service = new CatsService(new StubCatRepository());
  });

  it('should start with no cats', async () => {
    const cats = await service.findAll();
    expect(cats).toHaveLength(0);
  });

  it('should create a cat and return it with an id', async () => {
    const cat = await service.create({ name: 'Kitty', age: 3, breed: 'Russian Blue' });
    expect(cat.id).toBeDefined();
    expect(cat.name).toBe('Kitty');
    expect(cat.age).toBe(3);
    expect(cat.breed).toBe('Russian Blue');
  });

  it('should find a cat by id', async () => {
    const created = await service.create({ name: 'Milo', age: 2, breed: 'Tabby' });
    const found = await service.findById(created.id);
    expect(found).not.toBeNull();
    expect(found!.name).toBe('Milo');
  });

  it('should return null for unknown id', async () => {
    const found = await service.findById('non-existent-id');
    expect(found).toBeNull();
  });

  it('should remove a cat', async () => {
    const cat = await service.create({ name: 'Luna', age: 1, breed: 'Siamese' });
    await service.remove(cat.id);
    const cats = await service.findAll();
    expect(cats).toHaveLength(0);
  });

  it('should throw when removing a non-existent cat', async () => {
    await expect(service.remove('ghost-id')).rejects.toThrow('Cat ghost-id not found');
  });
});
