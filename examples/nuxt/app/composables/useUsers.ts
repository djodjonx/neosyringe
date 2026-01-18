/**
 * Composable for User Service
 *
 * This composable uses Neo-Syringe DI to resolve the UserService.
 * At build time, the container.resolve() calls are replaced with
 * generated factory code - zero runtime DI overhead!
 *
 * Also demonstrates TRANSIENT lifecycle with IOperationTracker:
 * Each operation gets its own tracker instance with unique ID.
 */
import { ref, readonly } from 'vue';

// Import the generated container
import { appContainer, TOKENS } from '../di/container';
import { UserService } from '../domain/user/services';
import type { User } from '../domain/user/entities';
import type { IOperationTracker } from '../shared-kernel/services';

export function useUsers() {
  // Resolve the UserService from the DI container (SINGLETON)
  const userService = appContainer.resolve(UserService);

  const users = ref<User[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);
  const lastOperationId = ref<string | null>(null);

  /**
   * Get a new operation tracker (TRANSIENT - new instance each call)
   */
  function getTracker(): IOperationTracker {
    return appContainer.resolve(TOKENS.IOperationTracker);
  }

  async function fetchUsers() {
    const tracker = getTracker();
    tracker.start('FetchUsers');
    lastOperationId.value = tracker.operationId;

    loading.value = true;
    error.value = null;
    try {
      users.value = await userService.getAllUsers();
      tracker.complete();
    } catch (e: unknown) {
      error.value = (e as Error).message;
      tracker.fail(e as Error);
    } finally {
      loading.value = false;
    }
  }

  async function createUser(email: string, name: string) {
    const tracker = getTracker();
    tracker.start('CreateUser');
    lastOperationId.value = tracker.operationId;

    loading.value = true;
    error.value = null;
    try {
      const user = await userService.createUser(email, name);
      users.value = [...users.value, user];
      tracker.complete();
      return user;
    } catch (e: unknown) {
      error.value = (e as Error).message;
      tracker.fail(e as Error);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  async function deleteUser(id: string) {
    const tracker = getTracker();
    tracker.start('DeleteUser');
    lastOperationId.value = tracker.operationId;

    loading.value = true;
    error.value = null;
    try {
      await userService.deleteUser(id);
      users.value = users.value.filter(u => u.id !== id);
      tracker.complete();
    } catch (e: unknown) {
      error.value = (e as Error).message;
      tracker.fail(e as Error);
      throw e;
    } finally {
      loading.value = false;
    }
  }

  return {
    users: readonly(users),
    loading: readonly(loading),
    error: readonly(error),
    lastOperationId: readonly(lastOperationId),
    fetchUsers,
    createUser,
    deleteUser
  };
}

