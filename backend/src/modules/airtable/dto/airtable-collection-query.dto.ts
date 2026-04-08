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

export class AirtableCollectionQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  integrationKey?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  baseId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  tableId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  recordId?: string;

  @IsOptional()
  @IsString()
  @IsIn(['status', 'assignee'])
  changeType?: 'status' | 'assignee';

  @IsOptional()
  @IsString()
  @MaxLength(256)
  search?: string;

  @IsOptional()
  @IsString()
  @MaxLength(128)
  @Matches(/^[a-zA-Z0-9_.-]+$/)
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
}
