import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

const toBoolean = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value === 'true' : value;

export class AirtableSessionLoginDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  integrationKey?: string;

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

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  forceRelogin?: boolean;
}
