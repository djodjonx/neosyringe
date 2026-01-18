/**
 * In-Memory Product Repository
 * Infrastructure adapter for IProductRepository.
 */
import type { IProductRepository } from '../../domain/product/repositories';
import { Product } from '../../domain/product/entities';

export class InMemoryProductRepository implements IProductRepository {
  private products = new Map<string, Product>();

  async findById(id: string): Promise<Product | null> {
    return this.products.get(id) ?? null;
  }

  async findAll(): Promise<Product[]> {
    return Array.from(this.products.values());
  }

  async save(product: Product): Promise<void> {
    this.products.set(product.id, product);
  }

  async delete(id: string): Promise<void> {
    this.products.delete(id);
  }
}

