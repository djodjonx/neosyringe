/**
 * User Service
 * Domain service for user operations.
 */
import { User } from '../entities';
import type { IUserRepository } from '../repositories';
import type { ILogger, IEventBus, DomainEvent } from '../../../shared-kernel/interfaces';

interface UserCreatedEvent extends DomainEvent {
  type: 'UserCreated';
  payload: { userId: string; email: string };
}

export class UserService {
  constructor(
    private readonly userRepository: IUserRepository,
    private readonly logger: ILogger,
    private readonly eventBus: IEventBus
  ) {}

  async createUser(email: string, name: string): Promise<User> {
    this.logger.info('Creating new user', { email, name });

    const existing = await this.userRepository.findByEmail(email);
    if (existing) {
      this.logger.warn('User already exists', { email });
      throw new Error(`User with email ${email} already exists`);
    }

    const user = User.create({
      id: crypto.randomUUID(),
      email,
      name
    });

    await this.userRepository.save(user);

    const event: UserCreatedEvent = {
      type: 'UserCreated',
      occurredAt: new Date(),
      payload: { userId: user.id, email: user.email.toString() }
    };
    this.eventBus.publish(event);

    this.logger.info('User created successfully', { userId: user.id });
    return user;
  }

  async getUser(id: string): Promise<User | null> {
    this.logger.debug('Fetching user', { id });
    return this.userRepository.findById(id);
  }

  async getAllUsers(): Promise<User[]> {
    this.logger.debug('Fetching all users');
    return this.userRepository.findAll();
  }

  async deleteUser(id: string): Promise<void> {
    this.logger.info('Deleting user', { id });
    await this.userRepository.delete(id);
  }
}

