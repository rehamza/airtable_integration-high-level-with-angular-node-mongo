import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { GridDataQueryDto } from './dto/grid-data-query.dto';
import { GridDeleteDto } from './dto/grid-delete.dto';
import { GridOptionsQueryDto } from './dto/grid-options-query.dto';
import { GridService } from './grid.service';

@Controller('grid')
export class GridController {
  constructor(private readonly gridService: GridService) {}

  @Get('options')
  getOptions(@Query() query: GridOptionsQueryDto): Promise<unknown> {
    return this.gridService.getOptions(query);
  }

  @Get('data')
  getData(@Query() query: GridDataQueryDto): Promise<unknown> {
    return this.gridService.getGridData(query);
  }

  @Post('delete')
  deleteRows(@Body() body: GridDeleteDto): Promise<unknown> {
    return this.gridService.deleteRows(body);
  }
}
