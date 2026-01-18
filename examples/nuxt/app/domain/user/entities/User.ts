/**
 * User Entity
 * Aggregate root for the User bounded context.
 */
import { Email } from '../../../shared-kernel/value-objects';

export interface UserProps {
  id: string;
  email: Email;
  name: string;
  createdAt: Date;
}

export class User {
  readonly id: string;
  readonly email: Email;
  readonly name: string;
  readonly createdAt: Date;

  private constructor(props: UserProps) {
    this.id = props.id;
    this.email = props.email;
    this.name = props.name;
    this.createdAt = props.createdAt;
  }

  static create(props: { id: string; email: string; name: string }): User {
    return new User({
      id: props.id,
      email: Email.create(props.email),
      name: props.name,
      createdAt: new Date()
    });
  }

  static reconstitute(props: UserProps): User {
    return new User(props);
  }
}

