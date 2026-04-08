import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class GridDataQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  integrationKey?: string;

  @IsString()
  @IsIn([
    'airtable_bases',
    'airtable_tables',
    'airtable_pages',
    'airtable_users',
    'airtable_revision_history',
  ])
  entity!: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  baseId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  processedEntity?: string;

  @IsOptional()
  @IsString()
  @MaxLength(256)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  sortBy?: string;

  @IsOptional()
  @IsString()
  @IsIn(['asc', 'desc'])
  sortOrder?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  pageSize?: number;

  @IsOptional()
  @IsString()
  filterModel?: string;
}
