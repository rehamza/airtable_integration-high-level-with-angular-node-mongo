import { Body, Controller, Get, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AirtableIntegrationQueryDto } from '../dto/airtable-integration-query.dto';
import { AirtableOAuthCallbackDto } from '../dto/airtable-oauth-callback.dto';
import { AirtableRefreshDto } from '../dto/airtable-refresh.dto';
import { AirtableRevisionHistorySyncDto } from '../dto/airtable-revision-history-sync.dto';
import { AirtableSessionLoginDto } from '../dto/airtable-session-login.dto';
import { AirtableSessionValidationDto } from '../dto/airtable-session-validation.dto';
import { AirtableSyncDto } from '../dto/airtable-sync.dto';
import { AirtableOAuthService } from '../services/airtable-oauth.service';
import { AirtableScraperService } from '../services/airtable-scraper.service';
import { AirtableSyncService } from '../services/airtable-sync.service';

@Controller('integrations/airtable')
export class AirtableIntegrationsController {
  constructor(
    private readonly airtableOAuthService: AirtableOAuthService,
    private readonly airtableSyncService: AirtableSyncService,
    private readonly airtableScraperService: AirtableScraperService,
  ) {}

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

  @Post('sync')
  sync(@Body() body: AirtableSyncDto) {
    return this.airtableSyncService.runFullSync(body);
  }

  @Post('session/login')
  sessionLogin(@Body() body: AirtableSessionLoginDto) {
    return this.airtableScraperService.refreshSessionCookies(body);
  }

  @Post('session/validate')
  sessionValidate(@Body() body: AirtableSessionValidationDto) {
    return this.airtableScraperService.validateSessionCookies(body);
  }

  @Post('revision-history/sync')
  revisionHistorySync(@Body() body: AirtableRevisionHistorySyncDto) {
    return this.airtableScraperService.scrapeRevisionHistory(body);
  }
}
