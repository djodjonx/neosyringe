<script setup lang="ts">
defineProps<{
  hoverable?: boolean;
}>();
</script>

<template>
  <div :class="['card', { 'card-hoverable': hoverable }]">
    <div v-if="$slots.header" class="card-header">
      <slot name="header" />
    </div>
    <div class="card-body">
      <slot />
    </div>
    <div v-if="$slots.footer" class="card-footer">
      <slot name="footer" />
    </div>
  </div>
</template>

<style scoped>
.card {
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  overflow: hidden;
  transition: all 0.2s ease;
}

.card-hoverable:hover {
  border-color: #0d9488;
  box-shadow: 0 8px 24px rgba(13, 148, 136, 0.12);
  transform: translateY(-2px);
}

.card-header {
  padding: 1rem 1.5rem;
  border-bottom: 1px solid #e5e7eb;
  background: #f9fafb;
  font-weight: 600;
  color: #374151;
}

.card-body {
  padding: 1.5rem;
}

.card-footer {
  padding: 1rem 1.5rem;
  border-top: 1px solid #e5e7eb;
  background: #f9fafb;
}
</style>

