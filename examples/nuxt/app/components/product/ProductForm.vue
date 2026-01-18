<script setup lang="ts">
import { reactive } from 'vue';

defineProps<{
  title?: string;
  submitText?: string;
  loading?: boolean;
}>();

const emit = defineEmits<{
  submit: [data: { name: string; price: number; stock: number }];
  cancel: [];
}>();

const form = reactive({
  name: '',
  price: 0,
  stock: 0
});

const errors = reactive({
  name: '',
  price: '',
  stock: ''
});

function validate(): boolean {
  errors.name = '';
  errors.price = '';
  errors.stock = '';

  if (!form.name.trim()) {
    errors.name = 'Product name is required';
  }

  if (form.price < 0) {
    errors.price = 'Price cannot be negative';
  }

  if (form.stock < 0) {
    errors.stock = 'Stock cannot be negative';
  }

  return !errors.name && !errors.price && !errors.stock;
}

function handleSubmit() {
  if (validate()) {
    emit('submit', {
      name: form.name,
      price: Number(form.price),
      stock: Number(form.stock)
    });
    form.name = '';
    form.price = 0;
    form.stock = 0;
  }
}
</script>

<template>
  <form class="product-form" @submit.prevent="handleSubmit">
    <div class="form-group">
      <label for="name">Product Name</label>
      <input
        id="name"
        v-model="form.name"
        type="text"
        placeholder="Enter product name"
        :class="['input', { 'input-error': errors.name }]"
      >
      <span v-if="errors.name" class="error-text">{{ errors.name }}</span>
    </div>

    <div class="form-row">
      <div class="form-group">
        <label for="price">Price ($)</label>
        <input
          id="price"
          v-model.number="form.price"
          type="number"
          step="0.01"
          min="0"
          placeholder="0.00"
          :class="['input', { 'input-error': errors.price }]"
        >
        <span v-if="errors.price" class="error-text">{{ errors.price }}</span>
      </div>

      <div class="form-group">
        <label for="stock">Initial Stock</label>
        <input
          id="stock"
          v-model.number="form.stock"
          type="number"
          min="0"
          placeholder="0"
          :class="['input', { 'input-error': errors.stock }]"
        >
        <span v-if="errors.stock" class="error-text">{{ errors.stock }}</span>
      </div>
    </div>

    <div class="form-actions">
      <button type="button" class="btn btn-ghost" @click="$emit('cancel')">
        Cancel
      </button>
      <button type="submit" class="btn btn-secondary" :disabled="loading">
        {{ loading ? 'Adding...' : submitText }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.product-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.form-group label {
  font-size: 0.875rem;
  font-weight: 500;
  color: #374151;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.input {
  width: 100%;
  padding: 0.75rem 1rem;
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  font-size: 1rem;
  transition: all 0.2s ease;
}

.input:focus {
  outline: none;
  border-color: #f97316;
  box-shadow: 0 0 0 3px rgba(249, 115, 22, 0.1);
}

.input-error {
  border-color: #ef4444;
}

.error-text {
  color: #ef4444;
  font-size: 0.75rem;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.75rem;
  margin-top: 0.5rem;
}

.btn {
  padding: 0.75rem 1.5rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  transition: all 0.2s;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-secondary {
  background: linear-gradient(135deg, #f97316 0%, #fb923c 100%);
  color: white;
}

.btn-secondary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(249, 115, 22, 0.3);
}

.btn-ghost {
  background: transparent;
  color: #6b7280;
  border: 1px solid #e5e7eb;
}

.btn-ghost:hover {
  background: #f3f4f6;
}
</style>

