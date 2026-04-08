import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AirtableIntegrationQueryDto } from '../dto/airtable-integration-query.dto';
import { AirtableOAuthCallbackDto } from '../dto/airtable-oauth-callback.dto';
import { AirtableRefreshDto } from '../dto/airtable-refresh.dto';
import { AirtableOAuthService } from '../services/airtable-oauth.service';

@Controller('integrations/airtable')
export class AirtableIntegrationsController {
  constructor(private readonly airtableOAuthService: AirtableOAuthService) {}

  @Get('status')
  getStatus(@Query() query: AirtableIntegrationQueryDto) {
    return this.airtableOAuthService.getConnectionStatus(query.integrationKey);
  }

  @Get('authorize')
  async authorize(
    @Query() query: AirtableIntegrationQueryDto,
    @Res() response: Response,
  ) {
    const authorization = await this.airtableOAuthService.createAuthorizationUrl(
      query.integrationKey,
    );

    return response.redirect(authorization.authorizationUrl);
  }

  @Get('callback')
  async callback(
    @Query() query: AirtableOAuthCallbackDto,
    @Res() response: Response,
  ) {
    const redirectUrl = await this.airtableOAuthService.handleCallback(query);

    return response.redirect(redirectUrl);
  }

  @Post('refresh')
  refresh(@Body() body: AirtableRefreshDto) {
    return this.airtableOAuthService.refreshAccessToken(body.integrationKey);
  }
}
