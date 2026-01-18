/**
 * Product Service
 * Domain service for product operations.
 */
import { Product } from '../entities';
import type { IProductRepository } from '../repositories';
import type { ILogger } from '../../../shared-kernel/interfaces';

export class ProductService {
  constructor(
    private readonly productRepository: IProductRepository,
    private readonly logger: ILogger
  ) {}

  async createProduct(name: string, price: number, stock: number): Promise<Product> {
    this.logger.info('Creating new product', { name, price, stock });

    const product = Product.create({
      id: crypto.randomUUID(),
      name,
      price,
      stock
    });

    await this.productRepository.save(product);
    this.logger.info('Product created', { productId: product.id });

    return product;
  }

  async getProduct(id: string): Promise<Product | null> {
    this.logger.debug('Fetching product', { id });
    return this.productRepository.findById(id);
  }

  async getAllProducts(): Promise<Product[]> {
    this.logger.debug('Fetching all products');
    return this.productRepository.findAll();
  }

  async updateStock(id: string, quantity: number): Promise<void> {
    const product = await this.productRepository.findById(id);
    if (!product) {
      throw new Error(`Product ${id} not found`);
    }

    if (quantity > 0) {
      product.addStock(quantity);
    } else {
      product.removeStock(Math.abs(quantity));
    }

    await this.productRepository.save(product);
    this.logger.info('Stock updated', { productId: id, newStock: product.stock });
  }
}

