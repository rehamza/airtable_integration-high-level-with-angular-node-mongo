import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { envCsv, envNumber } from '../../../config/env.utils';
import { AirtableOAuthCallbackDto } from '../dto/airtable-oauth-callback.dto';
import { IntegrationsService } from '../../integrations/services/integrations.service';
import { IntegrationDocument } from '../../integrations/schemas/integration.schema';

interface AirtableTokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
}

@Injectable()
export class AirtableOAuthService {
  constructor(
    private readonly configService: ConfigService,
    private readonly integrationsService: IntegrationsService,
  ) {}

  async createAuthorizationUrl(integrationKey?: string) {
    const normalizedIntegrationKey = this.normalizeIntegrationKey(integrationKey);
    const clientId = this.getRequiredConfig('AIRTABLE_CLIENT_ID');
    const redirectUri = this.getRequiredConfig('AIRTABLE_REDIRECT_URI');
    const scopes = envCsv(this.configService.get<string>('AIRTABLE_SCOPES'), []);
    const authorizeUrl = new URL(
      this.configService.get<string>('AIRTABLE_OAUTH_AUTHORIZE_URL') ??
        'https://airtable.com/oauth2/v1/authorize',
    );
    const state = randomBytes(32).toString('base64url');
    const codeVerifier = randomBytes(96).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    const pkceExpiry = new Date(
      Date.now() + envNumber(this.configService.get<string>('AIRTABLE_PKCE_TTL_MINUTES'), 15) * 60_000,
    );

    await this.integrationsService.upsertPkceState({
      provider: 'airtable',
      integrationKey: normalizedIntegrationKey,
      scopes,
      state,
      codeVerifier,
      expiresAt: pkceExpiry,
    });

    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');
    authorizeUrl.searchParams.set('state', state);
    authorizeUrl.searchParams.set('client_id', clientId);
    authorizeUrl.searchParams.set('redirect_uri', redirectUri);
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('scope', scopes.join(' '));

    return {
      integrationKey: normalizedIntegrationKey,
      authorizationUrl: authorizeUrl.toString(),
    };
  }

  async handleCallback(query: AirtableOAuthCallbackDto): Promise<string> {
    if (!query.state) {
      return this.buildFrontendCallbackUrl({
        status: 'error',
        message: 'Missing OAuth state from Airtable callback.',
      });
    }

    const integration = await this.integrationsService.findByPkceState('airtable', query.state);

    if (!integration) {
      return this.buildFrontendCallbackUrl({
        status: 'error',
        message: 'This Airtable authorization request is no longer valid. Start the sign-in flow again.',
      });
    }

    if (query.error) {
      await this.integrationsService.markAuthorizationError(
        integration,
        query.error_description ?? query.error,
      );

      return this.buildFrontendCallbackUrl({
        integrationKey: integration.integrationKey,
        status: 'error',
        message: query.error_description ?? query.error,
      });
    }

    if (!query.code) {
      await this.integrationsService.markAuthorizationError(
        integration,
        'Airtable did not provide an authorization code.',
      );

      return this.buildFrontendCallbackUrl({
        integrationKey: integration.integrationKey,
        status: 'error',
        message: 'Airtable did not provide an authorization code.',
      });
    }

    if (
      integration.pkce?.state !== query.state ||
      !integration.pkce?.codeVerifier ||
      !integration.pkce?.expiresAt ||
      integration.pkce.expiresAt.getTime() < Date.now()
    ) {
      await this.integrationsService.markAuthorizationError(
        integration,
        'The saved PKCE verifier is missing or expired.',
      );

      return this.buildFrontendCallbackUrl({
        integrationKey: integration.integrationKey,
        status: 'error',
        message: 'The saved PKCE verifier is missing or expired.',
      });
    }

    try {
      const tokenSet = await this.requestToken({
        grantType: 'authorization_code',
        code: query.code,
        codeVerifier: integration.pkce.codeVerifier,
      });

      await this.integrationsService.storeOAuthTokenSet(
        integration,
        this.mapTokenResponse(tokenSet),
      );

      return this.buildFrontendCallbackUrl({
        integrationKey: integration.integrationKey,
        status: 'success',
        message: 'Airtable account connected successfully.',
      });
    } catch (error) {
      const message = this.extractTokenErrorMessage(error);

      await this.integrationsService.markAuthorizationError(integration, message);

      return this.buildFrontendCallbackUrl({
        integrationKey: integration.integrationKey,
        status: 'error',
        message,
      });
    }
  }

  async getConnectionStatus(integrationKey?: string) {
    const normalizedIntegrationKey = this.normalizeIntegrationKey(integrationKey);
    const integration = await this.integrationsService.findOneByProviderAndKey(
      'airtable',
      normalizedIntegrationKey,
    );

    return this.integrationsService.toPublicStatus(
      integration,
      'airtable',
      normalizedIntegrationKey,
    );
  }

  async refreshAccessToken(integrationKey?: string) {
    const integration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      this.normalizeIntegrationKey(integrationKey),
    );

    if (!integration.oauth?.refreshToken) {
      throw new BadRequestException(
        'No Airtable refresh token is stored for this integration.',
      );
    }

    const tokenSet = await this.requestToken({
      grantType: 'refresh_token',
      refreshToken: integration.oauth.refreshToken,
    });
    const updatedIntegration = await this.integrationsService.storeOAuthTokenSet(
      integration,
      this.mapTokenResponse(tokenSet),
    );

    return this.integrationsService.toPublicStatus(
      updatedIntegration,
      'airtable',
      updatedIntegration.integrationKey,
    );
  }

  async getValidAccessToken(integrationKey?: string): Promise<string> {
    const integration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      this.normalizeIntegrationKey(integrationKey),
    );

    if (!integration.oauth?.accessToken && !integration.oauth?.refreshToken) {
      throw new UnauthorizedException('Airtable integration is not connected.');
    }

    if (!this.shouldRefreshAccessToken(integration)) {
      return integration.oauth.accessToken as string;
    }

    const refreshedStatus = await this.refreshAccessToken(integration.integrationKey);
    const refreshedIntegration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      refreshedStatus.integrationKey,
    );

    if (!refreshedIntegration.oauth?.accessToken) {
      throw new UnauthorizedException('Unable to refresh the Airtable access token.');
    }

    return refreshedIntegration.oauth.accessToken;
  }

  private shouldRefreshAccessToken(integration: IntegrationDocument): boolean {
    if (!integration.oauth?.accessToken) {
      return true;
    }

    if (!integration.oauth.expiresAt) {
      return false;
    }

    const refreshBufferMs =
      envNumber(
        this.configService.get<string>('AIRTABLE_TOKEN_REFRESH_BUFFER_SECONDS'),
        120,
      ) * 1000;

    return integration.oauth.expiresAt.getTime() <= Date.now() + refreshBufferMs;
  }

  private async requestToken(input: {
    grantType: 'authorization_code' | 'refresh_token';
    code?: string;
    codeVerifier?: string;
    refreshToken?: string;
  }): Promise<AirtableTokenResponse> {
    const clientId = this.getRequiredConfig('AIRTABLE_CLIENT_ID');
    const redirectUri = this.getRequiredConfig('AIRTABLE_REDIRECT_URI');
    const tokenUrl =
      this.configService.get<string>('AIRTABLE_OAUTH_TOKEN_URL') ??
      'https://airtable.com/oauth2/v1/token';
    const clientSecret = (this.configService.get<string>('AIRTABLE_CLIENT_SECRET') ?? '').trim();
    const body = new URLSearchParams();
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
    };

    if (clientSecret) {
      const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      headers.Authorization = `Basic ${credentials}`;
    }

    body.set('client_id', clientId);
    body.set('grant_type', input.grantType);

    if (input.grantType === 'authorization_code') {
      body.set('code', input.code ?? '');
      body.set('code_verifier', input.codeVerifier ?? '');
      body.set('redirect_uri', redirectUri);
    }

    if (input.grantType === 'refresh_token') {
      body.set('refresh_token', input.refreshToken ?? '');
    }

    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
    });
    const data = (await response.json().catch(() => null)) as
      | AirtableTokenResponse
      | { error?: string; error_description?: string }
      | null;

    if (!response.ok || !data || !('access_token' in data)) {
      const errorMessage =
        data && 'error_description' in data && data.error_description
          ? data.error_description
          : data && 'error' in data && data.error
            ? data.error
            : 'Airtable rejected the token request.';

      throw new UnauthorizedException(errorMessage);
    }

    return data;
  }

  private buildFrontendCallbackUrl(input: {
    status: 'success' | 'error';
    message: string;
    integrationKey?: string;
  }): string {
    const frontendUrl =
      this.configService.get<string>('FRONTEND_URL') ?? 'http://localhost:4200';
    const callbackPath =
      this.configService.get<string>('FRONTEND_AUTH_CALLBACK_PATH') ??
      '/auth/airtable/callback';
    const callbackUrl = new URL(callbackPath, frontendUrl);

    callbackUrl.searchParams.set('status', input.status);
    callbackUrl.searchParams.set('message', input.message);

    if (input.integrationKey) {
      callbackUrl.searchParams.set('integrationKey', input.integrationKey);
    }

    return callbackUrl.toString();
  }

  private getRequiredConfig(key: string): string {
    const value = this.configService.get<string>(key)?.trim();

    if (!value) {
      throw new InternalServerErrorException(
        `Missing required configuration value "${key}".`,
      );
    }

    return value;
  }

  private normalizeIntegrationKey(integrationKey?: string): string {
    return (
      integrationKey?.trim() ||
      this.configService.get<string>('AIRTABLE_DEFAULT_INTEGRATION_KEY') ||
      'default'
    );
  }

  private extractTokenErrorMessage(error: unknown): string {
    if (error instanceof UnauthorizedException) {
      const response = error.getResponse();

      if (typeof response === 'string') {
        return response;
      }

      if (response && typeof response === 'object' && 'message' in response) {
        const message = response.message;

        return Array.isArray(message) ? message.join(', ') : String(message);
      }
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Airtable token exchange failed.';
  }

  private mapTokenResponse(tokenSet: AirtableTokenResponse) {
    return {
      accessToken: tokenSet.access_token,
      refreshToken: tokenSet.refresh_token,
      tokenType: tokenSet.token_type,
      scope: tokenSet.scope,
      expiresIn: tokenSet.expires_in,
    };
  }
}
