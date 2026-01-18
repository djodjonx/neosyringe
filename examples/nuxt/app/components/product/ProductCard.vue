<script setup lang="ts">
import { computed } from 'vue';

interface Product {
  id: string;
  name: string;
  price: number;
  stock: number;
}

const props = defineProps<{
  product: Product;
}>();

defineEmits<{
  updateStock: [id: string, quantity: number];
}>();

const stockVariant = computed(() => {
  if (props.product.stock === 0) return 'danger';
  if (props.product.stock < 5) return 'warning';
  return 'success';
});
</script>

<template>
  <div class="product-card">
    <div class="product-image">
      📦
    </div>
    <div class="product-info">
      <h4>{{ product.name }}</h4>
      <div class="product-meta">
        <span class="price">${{ product.price.toFixed(2) }}</span>
        <span :class="['badge', `badge-${stockVariant}`]">
          {{ product.stock }} in stock
        </span>
      </div>
    </div>
    <div class="stock-controls">
      <button
        class="btn btn-sm"
        :disabled="product.stock === 0"
        @click="$emit('updateStock', product.id, -1)"
      >
        −
      </button>
      <span class="stock-count">{{ product.stock }}</span>
      <button
        class="btn btn-sm"
        @click="$emit('updateStock', product.id, 1)"
      >
        +
      </button>
    </div>
  </div>
</template>

<style scoped>
.product-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  transition: all 0.2s;
}

.product-card:hover {
  border-color: #f97316;
  box-shadow: 0 4px 12px rgba(249, 115, 22, 0.1);
}

.product-image {
  width: 60px;
  height: 60px;
  border-radius: 8px;
  background: linear-gradient(135deg, #f97316 0%, #fb923c 100%);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5rem;
  flex-shrink: 0;
}

.product-info {
  flex: 1;
  min-width: 0;
}

.product-info h4 {
  margin: 0 0 0.5rem 0;
  color: #1f2937;
  font-size: 1rem;
}

.product-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.price {
  font-weight: 600;
  color: #0d9488;
  font-size: 1.125rem;
}

.badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 500;
}

.badge-success {
  background: #d1fae5;
  color: #065f46;
}

.badge-warning {
  background: #fef3c7;
  color: #92400e;
}

.badge-danger {
  background: #fee2e2;
  color: #991b1b;
}

.stock-controls {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: #f3f4f6;
  border-radius: 6px;
  padding: 0.25rem;
}

.stock-count {
  min-width: 2rem;
  text-align: center;
  font-weight: 600;
  color: #374151;
}

.btn {
  padding: 0.5rem 0.75rem;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  background: white;
  color: #374151;
  font-weight: 600;
  transition: all 0.2s;
}

.btn:hover:not(:disabled) {
  background: #e5e7eb;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-sm {
  padding: 0.25rem 0.5rem;
  font-size: 1rem;
}
</style>

