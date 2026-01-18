<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  message: string;
  type?: 'success' | 'error' | 'warning' | 'info';
  visible: boolean;
}>();

defineEmits<{
  close: [];
}>();

const icon = computed(() => {
  switch (props.type) {
    case 'success': return '✓';
    case 'error': return '✕';
    case 'warning': return '⚠';
    default: return 'ℹ';
  }
});
</script>

<template>
  <Transition name="toast">
    <div v-if="visible" :class="['toast', `toast-${type}`]">
      <span class="toast-icon">{{ icon }}</span>
      <span class="toast-message">{{ message }}</span>
      <button class="toast-close" @click="$emit('close')">
        ×
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.toast {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1.25rem;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  font-size: 0.875rem;
}

.toast-success {
  background: #10b981;
  color: white;
}

.toast-error {
  background: #ef4444;
  color: white;
}

.toast-warning {
  background: #f59e0b;
  color: white;
}

.toast-info {
  background: #0d9488;
  color: white;
}

.toast-icon {
  font-size: 1.25rem;
  font-weight: bold;
}

.toast-message {
  flex: 1;
}

.toast-close {
  background: none;
  border: none;
  color: inherit;
  font-size: 1.5rem;
  cursor: pointer;
  opacity: 0.7;
  padding: 0;
  line-height: 1;
}

.toast-close:hover {
  opacity: 1;
}

.toast-enter-active,
.toast-leave-active {
  transition: all 0.3s ease;
}

.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateY(-20px);
}
</style>

