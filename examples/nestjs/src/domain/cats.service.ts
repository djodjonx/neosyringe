import { Cat } from './cat.entity';
import type { CreateCatInput } from './cat.entity';
import type { ICatRepository } from './i-cat-repository';

export class CatsService {
  constructor(private readonly repository: ICatRepository) {}

  findAll(): Promise<Cat[]> {
    return this.repository.findAll();
  }

  findById(id: string): Promise<Cat | null> {
    return this.repository.findById(id);
  }

  async create(input: CreateCatInput): Promise<Cat> {
    const cat = Cat.create(input);
    await this.repository.save(cat);
    return cat;
  }

  async remove(id: string): Promise<void> {
    const cat = await this.repository.findById(id);
    if (!cat) throw new Error(`Cat ${id} not found`);
    await this.repository.delete(id);
  }
}
