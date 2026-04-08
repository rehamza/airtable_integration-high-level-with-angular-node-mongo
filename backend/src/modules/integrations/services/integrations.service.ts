import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
  Integration,
  IntegrationDocument,
  IntegrationOAuthState,
} from '../schemas/integration.schema';

interface UpsertPkceStateInput {
  provider: 'airtable';
  integrationKey: string;
  scopes: string[];
  state: string;
  codeVerifier: string;
  codeChallengeMethod?: string;
  expiresAt: Date;
}

interface StoreOAuthTokenSetInput {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  scope?: string;
  expiresIn?: number;
}

@Injectable()
export class IntegrationsService {
  constructor(
    @InjectModel(Integration.name)
    private readonly integrationModel: Model<IntegrationDocument>,
  ) {}

  async findOneByProviderAndKey(
    provider: 'airtable',
    integrationKey: string,
  ): Promise<IntegrationDocument | null> {
    return this.integrationModel.findOne({ provider, integrationKey }).exec();
  }

  async findByPkceState(
    provider: 'airtable',
    state: string,
  ): Promise<IntegrationDocument | null> {
    return this.integrationModel.findOne({ provider, 'pkce.state': state }).exec();
  }

  async requireOneByProviderAndKey(
    provider: 'airtable',
    integrationKey: string,
  ): Promise<IntegrationDocument> {
    const integration = await this.findOneByProviderAndKey(provider, integrationKey);

    if (!integration) {
      throw new NotFoundException(`Integration "${integrationKey}" is not connected.`);
    }

    return integration;
  }

  async upsertPkceState(input: UpsertPkceStateInput): Promise<IntegrationDocument> {
    const integration =
      (await this.findOneByProviderAndKey(input.provider, input.integrationKey)) ??
      new this.integrationModel({
        provider: input.provider,
        integrationKey: input.integrationKey,
      });

    integration.provider = input.provider;
    integration.integrationKey = input.integrationKey;
    integration.displayName = this.buildDisplayName(input.provider, input.integrationKey);
    integration.authType = 'oauth';
    integration.status = 'pending';
    integration.isEnabled = true;
    integration.scopes = input.scopes;
    integration.pkce = {
      state: input.state,
      codeVerifier: input.codeVerifier,
      codeChallengeMethod: input.codeChallengeMethod ?? 'S256',
      expiresAt: input.expiresAt,
    };
    integration.lastAuthError = undefined;

    return integration.save();
  }

  async clearPkceState(integration: IntegrationDocument): Promise<IntegrationDocument> {
    integration.pkce = {};

    return integration.save();
  }

  async markAuthorizationError(
    integration: IntegrationDocument,
    errorMessage: string,
  ): Promise<IntegrationDocument> {
    integration.status = 'error';
    integration.lastAuthError = errorMessage;
    integration.pkce = {};

    return integration.save();
  }

  async storeOAuthTokenSet(
    integration: IntegrationDocument,
    tokenSet: StoreOAuthTokenSetInput,
  ): Promise<IntegrationDocument> {
    const refreshedAt = new Date();
    const expiresAt = tokenSet.expiresIn
      ? new Date(refreshedAt.getTime() + tokenSet.expiresIn * 1000)
      : integration.oauth?.expiresAt;
    const parsedScopes = tokenSet.scope ? this.parseScopes(tokenSet.scope) : integration.scopes;
    const nextOauthState: IntegrationOAuthState = {
      accessToken: tokenSet.accessToken,
      refreshToken: tokenSet.refreshToken ?? integration.oauth?.refreshToken,
      tokenType: tokenSet.tokenType ?? integration.oauth?.tokenType,
      scope: tokenSet.scope ?? integration.oauth?.scope,
      expiresAt,
      lastRefreshedAt: refreshedAt,
    };

    integration.status = 'active';
    integration.authType = 'oauth';
    integration.isEnabled = true;
    integration.scopes = parsedScopes;
    integration.oauth = nextOauthState;
    integration.connectedAt ??= refreshedAt;
    integration.lastAuthError = undefined;
    integration.pkce = {};

    return integration.save();
  }

  toPublicStatus(
    integration: IntegrationDocument | null,
    provider: 'airtable',
    integrationKey: string,
  ) {
    const expiresAt = integration?.oauth?.expiresAt ?? null;
    const isConnected = Boolean(
      integration &&
        integration.status === 'active' &&
        (integration.oauth?.refreshToken || integration.oauth?.accessToken),
    );

    return {
      provider,
      integrationKey,
      displayName: integration?.displayName ?? this.buildDisplayName(provider, integrationKey),
      status: integration?.status ?? 'not_connected',
      authType: integration?.authType ?? 'oauth',
      isEnabled: integration?.isEnabled ?? true,
      isConnected,
      scopes: integration?.scopes ?? [],
      expiresAt,
      connectedAt: integration?.connectedAt ?? null,
      lastRefreshedAt: integration?.oauth?.lastRefreshedAt ?? null,
      lastAuthError: integration?.lastAuthError ?? null,
      hasRefreshToken: Boolean(integration?.oauth?.refreshToken),
      accessTokenExpired: expiresAt ? expiresAt.getTime() <= Date.now() : false,
    };
  }

  private buildDisplayName(provider: 'airtable', integrationKey: string): string {
    if (provider === 'airtable' && integrationKey === 'default') {
      return 'Airtable';
    }

    return `${provider[0].toUpperCase()}${provider.slice(1)} (${integrationKey})`;
  }

  private parseScopes(scopeValue: string): string[] {
    return scopeValue
      .split(/[,\s]+/)
      .map((scope) => scope.trim())
      .filter(Boolean);
  }
}
