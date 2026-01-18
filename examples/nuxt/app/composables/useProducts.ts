/**
 * Composable for Product Service
 *
 * This composable uses Neo-Syringe DI to resolve the ProductService.
 * At build time, the container.resolve() calls are replaced with
 * generated factory code - zero runtime DI overhead!
 *
 * Also demonstrates TRANSIENT lifecycle with IRequestContext:
 * Each batch of operations gets its own context with unique requestId.
 */
import { ref, readonly } from 'vue';
import { useInterface } from '@djodjonx/neosyringe';

// Import the generated container
import { appContainer } from '../di/container';
import { ProductService } from '../domain/product/services';
import type { Product } from '../domain/product/entities';
import type { IRequestContext } from '../shared-kernel/services';

export function useProducts() {
  // Resolve the ProductService from the DI container (SINGLETON)
  // Same instance used throughout the app
  const productService = appContainer.resolve(ProductService);

  const products = ref<Product[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastRequestId = ref<string | null>(null);

  /**
   * Get a new request context (TRANSIENT - new instance each call)
   * useInterface<IRequestContext>() is transformed at compile-time to its tokenId
   */
  function getRequestContext(): IRequestContext {
    // Each call creates a NEW instance because lifecycle: 'transient'
    return appContainer.resolve(useInterface<IRequestContext>());
  }

  async function fetchProducts() {
    const ctx = getRequestContext();
    ctx.setMetadata('action', 'FetchProducts');
    lastRequestId.value = ctx.requestId;

    loading.value = true;
    error.value = null;
    try {
      products.value = await productService.getAllProducts();
      console.log(`[Request ${ctx.requestId}] FetchProducts completed`);
    } catch (e: any) {
      error.value = e.message;
      console.log(`[Request ${ctx.requestId}] FetchProducts failed: ${e.message}`);
    } finally {
      loading.value = false;
    }
  }

  async function createProduct(name: string, price: number, stock: number) {
    const ctx = getRequestContext();
    ctx.setMetadata('action', 'CreateProduct');
    ctx.setMetadata('productName', name);
    lastRequestId.value = ctx.requestId;

    loading.value = true;
    error.value = null;
    try {
      const product = await productService.createProduct(name, price, stock);
      products.value = [...products.value, product];
      console.log(`[Request ${ctx.requestId}] CreateProduct completed: ${product.id}`);
      return product;
    } catch (e: any) {
      error.value = e.message;
      console.log(`[Request ${ctx.requestId}] CreateProduct failed: ${e.message}`);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function updateStock(id: string, quantity: number) {
    const ctx = getRequestContext();
    ctx.setMetadata('action', 'UpdateStock');
    ctx.setMetadata('productId', id);
    ctx.setMetadata('quantity', quantity);
    lastRequestId.value = ctx.requestId;

    loading.value = true;
    error.value = null;
    try {
      await productService.updateStock(id, quantity);
      // Refresh products list after update
      await fetchProducts();
      console.log(`[Request ${ctx.requestId}] UpdateStock completed`);
    } catch (e: any) {
      error.value = e.message;
      console.log(`[Request ${ctx.requestId}] UpdateStock failed: ${e.message}`);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  return {
    products: readonly(products),
    loading: readonly(loading),
    error: readonly(error),
    lastRequestId: readonly(lastRequestId),
    fetchProducts,
    createProduct,
    updateStock
  };
}

