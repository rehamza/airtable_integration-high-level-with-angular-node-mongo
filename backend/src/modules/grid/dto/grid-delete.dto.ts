import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsMongoId, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class GridDeleteDto {
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

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsMongoId({ each: true })
  ids!: string[];
}
