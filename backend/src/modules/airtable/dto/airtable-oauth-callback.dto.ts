import { IsOptional, IsString } from 'class-validator';

export class AirtableOAuthCallbackDto {
  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  error?: string;

  @IsOptional()
  @IsString()
  error_description?: string;

  // Airtable may echo PKCE query params back to the callback URL.
  // They are not used by our callback handler, but must be allowed so
  // the global validation pipe does not reject the request.
  @IsOptional()
  @IsString()
  code_challenge?: string;

  @IsOptional()
  @IsString()
  code_challenge_method?: string;
}
