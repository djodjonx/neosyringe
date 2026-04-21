import { Body, Controller, Delete, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { CatsService } from '../domain/cats.service';
import { CreateCatDto } from './dto/create-cat.dto';

@Controller('cats')
export class CatsController {
  constructor(private readonly catsService: CatsService) {}

  @Get()
  findAll() {
    return this.catsService.findAll();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    const cat = await this.catsService.findById(id);
    if (!cat) throw new NotFoundException(`Cat ${id} not found`);
    return cat;
  }

  @Post()
  create(@Body() dto: CreateCatDto) {
    return this.catsService.create(dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.catsService.remove(id);
  }
}
