<script setup lang="ts">
defineOptions({
  inheritAttrs: false
});

defineProps<{
  modelValue: string | number;
  type?: 'text' | 'email' | 'number' | 'password';
  placeholder?: string;
  disabled?: boolean;
  error?: string;
}>();

defineEmits<{
  'update:modelValue': [value: string];
}>();
</script>

<template>
  <div class="input-wrapper">
    <input
      :value="modelValue"
      :type="type"
      :placeholder="placeholder"
      :disabled="disabled"
      :class="['input', { 'input-error': error }]"
      v-bind="$attrs"
      @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
    >
    <span v-if="error" class="error-text">{{ error }}</span>
  </div>
</template>

<style scoped>
.input-wrapper {
  width: 100%;
}

.input {
  width: 100%;
  padding: 0.75rem 1rem;
  border: 2px solid #e5e7eb;
  border-radius: 8px;
  font-size: 1rem;
  transition: all 0.2s ease;
  background: white;
}

.input:focus {
  outline: none;
  border-color: #0d9488;
  box-shadow: 0 0 0 3px rgba(13, 148, 136, 0.1);
}

.input:disabled {
  background: #f3f4f6;
  cursor: not-allowed;
}

.input-error {
  border-color: #ef4444;
}

.input-error:focus {
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
}

.error-text {
  display: block;
  margin-top: 0.25rem;
  color: #ef4444;
  font-size: 0.75rem;
}
</style>

