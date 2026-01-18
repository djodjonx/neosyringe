/**
 * Value Object - Email
 * Immutable object representing a valid email address.
 */
export class Email {
  private constructor(private readonly value: string) {}

  static create(email: string): Email {
    if (!email || !email.includes('@')) {
      throw new Error(`Invalid email: ${email}`);
    }
    return new Email(email.toLowerCase().trim());
  }

  toString(): string {
    return this.value;
  }

  equals(other: Email): boolean {
    return this.value === other.value;
  }
}

