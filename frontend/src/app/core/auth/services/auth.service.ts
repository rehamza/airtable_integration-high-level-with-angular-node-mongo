import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { clientAppConfig } from '../../config/client-app-config';
import { IntegrationAuthStatus } from '../models/integration-auth-status.model';

const DEFAULT_STATUS: IntegrationAuthStatus = {
  provider: 'airtable',
  integrationKey: clientAppConfig.airtableIntegrationKey,
  displayName: 'Airtable',
  status: 'not_connected',
  authType: 'oauth',
  isEnabled: true,
  isConnected: false,
  scopes: [],
  expiresAt: null,
  connectedAt: null,
  lastRefreshedAt: null,
  lastAuthError: null,
  hasRefreshToken: false,
  accessTokenExpired: false,
  checked: false,
  errorMessage: null,
};

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly httpClient = inject(HttpClient);
  private readonly authStatusState = signal<IntegrationAuthStatus>(DEFAULT_STATUS);
  private readonly loadingState = signal(false);

  readonly status = this.authStatusState.asReadonly();
  readonly isBusy = this.loadingState.asReadonly();
  readonly isAuthenticated = computed(() => this.authStatusState().isConnected);

  async loadStatus(options: { force?: boolean } = {}): Promise<IntegrationAuthStatus> {
    if (this.authStatusState().checked && !options.force) {
      return this.authStatusState();
    }

    this.loadingState.set(true);

    try {
      const status = await firstValueFrom(
        this.httpClient.get<IntegrationAuthStatus>(
          `${clientAppConfig.apiBaseUrl}/integrations/airtable/status`,
          {
            params: {
              integrationKey: clientAppConfig.airtableIntegrationKey,
            },
          },
        ),
      );
      const normalizedStatus = {
        ...status,
        checked: true,
        errorMessage: null,
      };

      this.authStatusState.set(normalizedStatus);

      return normalizedStatus;
    } catch (error) {
      const fallbackStatus: IntegrationAuthStatus = {
        ...DEFAULT_STATUS,
        checked: true,
        errorMessage: this.describeHttpError(error),
      };

      this.authStatusState.set(fallbackStatus);

      return fallbackStatus;
    } finally {
      this.loadingState.set(false);
    }
  }

  startAirtableSignIn(): void {
    const authorizationUrl = new URL(
      `${clientAppConfig.apiBaseUrl}/integrations/airtable/authorize`,
    );

    authorizationUrl.searchParams.set(
      'integrationKey',
      clientAppConfig.airtableIntegrationKey,
    );
    globalThis.location.assign(authorizationUrl.toString());
  }

  async refreshConnection(): Promise<IntegrationAuthStatus> {
    this.loadingState.set(true);

    try {
      const refreshedStatus = await firstValueFrom(
        this.httpClient.post<IntegrationAuthStatus>(
          `${clientAppConfig.apiBaseUrl}/integrations/airtable/refresh`,
          {
            integrationKey: clientAppConfig.airtableIntegrationKey,
          },
        ),
      );
      const normalizedStatus = {
        ...refreshedStatus,
        checked: true,
        errorMessage: null,
      };

      this.authStatusState.set(normalizedStatus);

      return normalizedStatus;
    } catch (error) {
      const failedStatus: IntegrationAuthStatus = {
        ...this.authStatusState(),
        checked: true,
        errorMessage: this.describeHttpError(error),
      };

      this.authStatusState.set(failedStatus);

      return failedStatus;
    } finally {
      this.loadingState.set(false);
    }
  }

  private describeHttpError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (typeof error.error === 'string' && error.error.trim()) {
        return error.error;
      }

      if (
        error.error &&
        typeof error.error === 'object' &&
        'message' in error.error &&
        error.error.message
      ) {
        const message = error.error.message;

        return Array.isArray(message) ? message.join(', ') : String(message);
      }

      if (error.status === 0) {
        return 'The backend is unreachable. Start the Nest API on port 3007.';
      }

      return `The request failed with status ${error.status}.`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'An unexpected authentication error occurred.';
  }
}
