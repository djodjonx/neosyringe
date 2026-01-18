<script setup lang="ts">
import { onMounted, reactive } from 'vue';
import { useUsers } from '../composables/useUsers';
import UserForm from '../components/user/UserForm.vue';
import UserCard from '../components/user/UserCard.vue';

const { users, loading, fetchUsers, createUser, deleteUser } = useUsers();

const toast = reactive({
  visible: false,
  message: '',
  type: 'success' as 'success' | 'error'
});

onMounted(() => {
  fetchUsers();
});

function showToast(message: string, type: 'success' | 'error') {
  toast.message = message;
  toast.type = type;
  toast.visible = true;
  setTimeout(() => {
    toast.visible = false;
  }, 3000);
}

async function handleCreateUser(data: { name: string; email: string }) {
  try {
    await createUser(data.email, data.name);
    showToast(`User "${data.name}" created successfully!`, 'success');
  } catch (e: unknown) {
    showToast((e as Error).message, 'error');
  }
}

async function handleDelete(id: string) {
  try {
    await deleteUser(id);
    showToast('User deleted successfully', 'success');
  } catch (e: unknown) {
    showToast((e as Error).message, 'error');
  }
}
</script>

<template>
  <div class="page">
    <div class="page-header">
      <h1>👥 User Management</h1>
      <p>Manage users using the User bounded context</p>
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

    <!-- Create User Form -->
    <div class="card">
      <div class="card-header">
        ➕ Create New User
      </div>
      <div class="card-body">
        <UserForm
          title=""
          submit-text="Create User"
          :loading="loading"
          @submit="handleCreateUser"
          @cancel="() => {}"
        />
      </div>
    </div>

    <!-- Users List -->
    <section class="users-section">
      <div class="section-header">
        <h2>Registered Users</h2>
        <span class="badge badge-info">{{ users.length }} users</span>
      </div>

      <div v-if="loading && users.length === 0" class="loading-state">
        <div class="spinner" />
        <p>Loading users...</p>
      </div>

      <div v-else-if="users.length === 0" class="empty-state">
        <span class="empty-icon">👥</span>
        <p>No users yet. Create one above!</p>
      </div>

      <TransitionGroup v-else name="list" tag="div" class="users-list">
        <UserCard
          v-for="user in users"
          :key="user.id"
          :user="user"
          @delete="handleDelete"
        />
      </TransitionGroup>
    </section>
  </div>
</template>

<style scoped>
.page {
  padding: 2rem;
  max-width: 800px;
  margin: 0 auto;
}

.page-header {
  margin-bottom: 2rem;
}

.page-header h1 {
  margin: 0 0 0.5rem 0;
  color: #0d9488;
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

.users-section {
  margin-top: 2rem;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.section-header h2 {
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

.badge-info {
  background: #ccfbf1;
  color: #0f766e;
}

.users-list {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
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
  border-top-color: #0d9488;
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

/* List transition animations */
.list-enter-active,
.list-leave-active {
  transition: all 0.3s ease;
}

.list-enter-from {
  opacity: 0;
  transform: translateX(-20px);
}

.list-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
</style>

