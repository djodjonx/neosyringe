<script setup lang="ts">
import { reactive } from 'vue';

const props = defineProps<{
  title?: string;
  submitText?: string;
  loading?: boolean;
  initialData?: { name: string; email: string };
}>();

const emit = defineEmits<{
  submit: [data: { name: string; email: string }];
  cancel: [];
}>();

const form = reactive({
  name: props.initialData?.name ?? '',
  email: props.initialData?.email ?? ''
});

const errors = reactive({
  name: '',
  email: ''
});

function validate(): boolean {
  errors.name = '';
  errors.email = '';

  if (!form.name.trim()) {
    errors.name = 'Name is required';
  }

  if (!form.email.trim()) {
    errors.email = 'Email is required';
  } else if (!form.email.includes('@')) {
    errors.email = 'Invalid email format';
  }

  return !errors.name && !errors.email;
}

function handleSubmit() {
  if (validate()) {
    emit('submit', { name: form.name, email: form.email });
    form.name = '';
    form.email = '';
  }
}
</script>

<template>
  <form class="user-form" @submit.prevent="handleSubmit">
    <div class="form-group">
      <label for="name">Name</label>
      <input
        id="name"
        v-model="form.name"
        type="text"
        placeholder="Enter name"
        :class="['input', { 'input-error': errors.name }]"
      >
      <span v-if="errors.name" class="error-text">{{ errors.name }}</span>
    </div>

    <div class="form-group">
      <label for="email">Email</label>
      <input
        id="email"
        v-model="form.email"
        type="email"
        placeholder="Enter email"
        :class="['input', { 'input-error': errors.email }]"
      >
      <span v-if="errors.email" class="error-text">{{ errors.email }}</span>
    </div>

    <div class="form-actions">
      <button type="button" class="btn btn-ghost" @click="$emit('cancel')">
        Cancel
      </button>
      <button type="submit" class="btn btn-primary" :disabled="loading">
        {{ loading ? 'Creating...' : submitText }}
      </button>
    </div>
  </form>
</template>

<style scoped>
.user-form {
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
  border-color: #0d9488;
  box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.1);
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

.btn-primary {
  background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(13, 148, 136, 0.3);
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

