import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class AirtableSyncDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  integrationKey?: string;

  @IsOptional()
  @IsBoolean()
  includeRecords?: boolean;

  @IsOptional()
  @IsBoolean()
  includeUsers?: boolean;
}
