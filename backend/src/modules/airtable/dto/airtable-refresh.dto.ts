import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class AirtableRefreshDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  integrationKey?: string;
}
