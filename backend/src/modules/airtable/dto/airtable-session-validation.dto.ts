import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';

const toBoolean = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value === 'true' : value;

export class AirtableSessionValidationDto {
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
  @Transform(toBoolean)
  @IsBoolean()
  forceRelogin?: boolean;
}
