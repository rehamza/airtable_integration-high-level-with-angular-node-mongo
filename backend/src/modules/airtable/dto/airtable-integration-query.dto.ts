import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class AirtableIntegrationQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[a-zA-Z0-9_-]+$/)
  integrationKey?: string;
}
