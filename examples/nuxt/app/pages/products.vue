<script setup lang="ts">
import { onMounted, reactive, computed } from 'vue';
import { useProducts } from '../composables/useProducts';
import ProductForm from '../components/product/ProductForm.vue';
import ProductCard from '../components/product/ProductCard.vue';

const { products, loading, fetchProducts, createProduct, updateStock } = useProducts();

const toast = reactive({
  visible: false,
  message: '',
  type: 'success' as 'success' | 'error'
});

const totalStock = computed(() =>
  products.value.reduce((sum, p) => sum + p.stock, 0)
);

const totalValue = computed(() =>
  products.value.reduce((sum, p) => sum + (p.price * p.stock), 0)
);

const lowStockCount = computed(() =>
  products.value.filter(p => p.stock < 5).length
);

const averagePrice = computed(() => {
  if (products.value.length === 0) return 0;
  return products.value.reduce((sum, p) => sum + p.price, 0) / products.value.length;
});

onMounted(() => {
  fetchProducts();
});

function showToast(message: string, type: 'success' | 'error') {
  toast.message = message;
  toast.type = type;
  toast.visible = true;
  setTimeout(() => {
    toast.visible = false;
  }, 3000);
}

async function handleCreateProduct(data: { name: string; price: number; stock: number }) {
  try {
    await createProduct(data.name, data.price, data.stock);
    showToast(`Product "${data.name}" added successfully!`, 'success');
  } catch (e: unknown) {
    showToast((e as Error).message, 'error');
  }
}

async function handleUpdateStock(id: string, quantity: number) {
  try {
    await updateStock(id, quantity);
  } catch (e: unknown) {
    showToast((e as Error).message, 'error');
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>📦 Product Catalog</h1>
      <p>Manage products using the Product bounded context</p>
    </div>

    <!-- Toast notifications -->
    <div v-if="toast.visible" class="toast-container">
      <div :class="['toast', `toast-${toast.type}`]">
        {{ toast.message }}
        <button @click="toast.visible = false">
          ×
        </button>
      </div>
    </div>

    <!-- Create Product Form -->
    <div class="card">
      <div class="card-header">
        ➕ Add New Product
      </div>
      <div class="card-body">
        <ProductForm
          title=""
          submit-text="Add Product"
          :loading="loading"
          @submit="handleCreateProduct"
          @cancel="() => {}"
        />
      </div>
    </div>

    <!-- Products List -->
    <section class="products-section">
      <div class="section-header">
        <h2>Product Inventory</h2>
        <span class="badge badge-success">{{ products.length }} products</span>
        <span class="badge badge-info">{{ totalStock }} total stock</span>
      </div>

      <div v-if="loading && products.length === 0" class="loading-state">
        <div class="spinner" />
        <p>Loading products...</p>
      </div>

      <div v-else-if="products.length === 0" class="empty-state">
        <span class="empty-icon">📦</span>
        <p>No products yet. Add one above!</p>
      </div>

      <TransitionGroup v-else name="list" tag="div" class="products-grid">
        <ProductCard
          v-for="product in products"
          :key="product.id"
          :product="product"
          @update-stock="handleUpdateStock"
        />
      </TransitionGroup>
    </section>

    <!-- Stats -->
    <section v-if="products.length > 0" class="stats-section">
      <h2>📊 Inventory Stats</h2>
      <div class="stats-grid">
        <div class="stat-card">
          <span class="stat-value">${{ totalValue.toFixed(2) }}</span>
          <span class="stat-label">Total Inventory Value</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">{{ lowStockCount }}</span>
          <span class="stat-label">Low Stock Items (&lt;5)</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">${{ averagePrice.toFixed(2) }}</span>
          <span class="stat-label">Average Price</span>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.page {
  padding: 2rem;
  max-width: 1000px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 2rem;
}

.page-header h1 {
  margin: 0 0 0.5rem 0;
  color: #f97316;
}

.page-header p {
  margin: 0;
  color: #6b7280;
}

.toast-container {
  position: fixed;
  top: 80px;
  right: 20px;
  z-index: 1000;
}

.toast {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem;
  border-radius: 8px;
  color: white;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.toast-success {
  background: #10b981;
}

.toast-error {
  background: #ef4444;
}

.toast button {
  background: none;
  border: none;
  color: white;
  font-size: 1.5rem;
  cursor: pointer;
}

.card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  overflow: hidden;
  margin-bottom: 2rem;
}

.card-header {
  padding: 1rem 1.5rem;
  background: #f9fafb;
  border-bottom: 1px solid #e5e7eb;
  font-weight: 600;
}

.card-body {
  padding: 1.5rem;
}

.products-section,
.stats-section {
  margin-top: 2rem;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.section-header h2,
.stats-section h2 {
  margin: 0;
  color: #1f2937;
  font-size: 1.25rem;
}

.badge {
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 500;
}

.badge-success {
  background: #d1fae5;
  color: #065f46;
}

.badge-info {
  background: #ccfbf1;
  color: #0f766e;
}

.products-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 1rem;
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 3rem;
  color: #6b7280;
}

.loading-state .spinner {
  width: 40px;
  height: 40px;
  border: 3px solid #e5e7eb;
  border-top-color: #f97316;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 1rem;
}

.empty-icon {
  font-size: 3rem;
  display: block;
  margin-bottom: 1rem;
  opacity: 0.5;
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
  margin-top: 1rem;
}

.stat-card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  padding: 1.5rem;
  text-align: center;
}

.stat-value {
  display: block;
  font-size: 1.75rem;
  font-weight: 700;
  color: #0d9488;
}

.stat-label {
  display: block;
  font-size: 0.875rem;
  color: #6b7280;
  margin-top: 0.25rem;
}

/* List transition animations */
.list-enter-active,
.list-leave-active {
  transition: all 0.3s ease;
}

.list-enter-from {
  opacity: 0;
  transform: scale(0.9);
}

.list-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

