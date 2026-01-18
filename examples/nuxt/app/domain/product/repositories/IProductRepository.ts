/**
 * Product Repository Interface
 * Port for product persistence (Domain Layer).
 */
import type { Product } from '../entities';

export interface IProductRepository {
  findById(id: string): Promise<Product | null>;
  findAll(): Promise<Product[]>;
  save(product: Product): Promise<void>;
  delete(id: string): Promise<void>;
}

