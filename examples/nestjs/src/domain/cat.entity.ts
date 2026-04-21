export interface CreateCatInput {
  name: string;
  age: number;
  breed: string;
}

export class Cat {
  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly age: number,
    public readonly breed: string,
  ) {}

  static create(input: CreateCatInput): Cat {
    return new Cat(crypto.randomUUID(), input.name, input.age, input.breed);
  }
}
