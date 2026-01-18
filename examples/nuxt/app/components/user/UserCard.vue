<script setup lang="ts">
import { computed } from 'vue';

interface User {
  id: string;
  name: string;
  email: { toString(): string };
  createdAt: Date;
}

const props = defineProps<{
  user: User;
}>();

defineEmits<{
  delete: [id: string];
}>();

const initials = computed(() => {
  return props.user.name
    .split(' ')
    .map(n => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2);
});

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  }).format(date);
}
</script>

<template>
  <div class="user-card">
    <div class="user-avatar">
      {{ initials }}
    </div>
    <div class="user-info">
      <h4>{{ user.name }}</h4>
      <p>{{ user.email.toString() }}</p>
      <span class="badge">Created {{ formatDate(user.createdAt) }}</span>
    </div>
    <button class="btn btn-danger" @click="$emit('delete', user.id)">
      🗑️ Delete
    </button>
  </div>
</template>

<style scoped>
.user-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
  background: white;
  border: 1px solid #e5e7eb;
  border-radius: 12px;
  transition: all 0.2s;
}

.user-card:hover {
  border-color: #0d9488;
  box-shadow: 0 4px 12px rgba(13, 148, 136, 0.1);
}

.user-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: linear-gradient(135deg, #0d9488 0%, #14b8a6 100%);
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 1rem;
  flex-shrink: 0;
}

.user-info {
  flex: 1;
  min-width: 0;
}

.user-info h4 {
  margin: 0 0 0.25rem 0;
  color: #1f2937;
  font-size: 1rem;
}

.user-info p {
  margin: 0 0 0.5rem 0;
  color: #6b7280;
  font-size: 0.875rem;
}

.badge {
  display: inline-block;
  padding: 0.25rem 0.75rem;
  background: #ccfbf1;
  color: #0f766e;
  border-radius: 9999px;
  font-size: 0.75rem;
  font-weight: 500;
}

.btn {
  padding: 0.5rem 1rem;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.btn-danger {
  background: #ef4444;
  color: white;
}

.btn-danger:hover {
  background: #dc2626;
}
</style>

