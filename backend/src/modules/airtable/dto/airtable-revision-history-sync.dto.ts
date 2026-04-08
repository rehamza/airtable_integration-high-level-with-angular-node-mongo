import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const toBoolean = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value === 'true' : value;

const toStringArray = ({ value }: { value: unknown }) => {
  if (Array.isArray(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return undefined;
};

export class AirtableRevisionHistorySyncDto {
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
  @Transform(toStringArray)
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  recordIds?: string[];

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(5000)
  limit?: number;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  forceRelogin?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(320)
  email?: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(256)
  password?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32)
  mfaCode?: string;
}
