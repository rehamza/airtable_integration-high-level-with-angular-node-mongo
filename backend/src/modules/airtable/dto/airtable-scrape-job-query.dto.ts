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

export class AirtableScrapeJobQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  integrationKey?: string;

  @IsOptional()
  @IsString()
  @IsIn(['revision_history', 'cookie_validation', 'session_login'])
  jobType?: 'revision_history' | 'cookie_validation' | 'session_login';

  @IsOptional()
  @IsString()
  @IsIn(['queued', 'running', 'completed', 'failed', 'cancelled'])
  status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  @MaxLength(256)
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  pageSize?: number;
}
