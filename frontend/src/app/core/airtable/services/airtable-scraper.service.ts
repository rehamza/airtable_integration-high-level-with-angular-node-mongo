import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { clientAppConfig } from '../../config/client-app-config';
import {
  AirtableCookieSessionStatus,
  AirtableCookieValidationResult,
  AirtableRevisionHistoryScrapeResult,
} from '../models/airtable-scraper.model';

interface ScraperPayload {
  email?: string;
  password?: string;
  mfaCode?: string;
  forceRelogin?: boolean;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class AirtableScraperService {
  private readonly httpClient = inject(HttpClient);

  async refreshSessionCookies(
    payload: ScraperPayload,
  ): Promise<AirtableCookieSessionStatus> {
    try {
      return await firstValueFrom(
        this.httpClient.post<AirtableCookieSessionStatus>(
          `${clientAppConfig.apiBaseUrl}/integrations/airtable/session/login`,
          {
            integrationKey: clientAppConfig.airtableIntegrationKey,
            ...payload,
          },
        ),
      );
    } catch (error) {
      throw new Error(this.describeHttpError(error));
    }
  }

  async validateSessionCookies(
    payload: Pick<ScraperPayload, 'forceRelogin'> = {},
  ): Promise<AirtableCookieValidationResult> {
    try {
      return await firstValueFrom(
        this.httpClient.post<AirtableCookieValidationResult>(
          `${clientAppConfig.apiBaseUrl}/integrations/airtable/session/validate`,
          {
            integrationKey: clientAppConfig.airtableIntegrationKey,
            ...payload,
          },
        ),
      );
    } catch (error) {
      throw new Error(this.describeHttpError(error));
    }
  }

  async scrapeRevisionHistory(
    payload: ScraperPayload,
  ): Promise<AirtableRevisionHistoryScrapeResult> {
    try {
      return await firstValueFrom(
        this.httpClient.post<AirtableRevisionHistoryScrapeResult>(
          `${clientAppConfig.apiBaseUrl}/integrations/airtable/revision-history/sync`,
          {
            integrationKey: clientAppConfig.airtableIntegrationKey,
            ...payload,
          },
        ),
      );
    } catch (error) {
      throw new Error(this.describeHttpError(error));
    }
  }

  private describeHttpError(error: unknown): string {
    if (error instanceof HttpErrorResponse) {
      if (
        error.error &&
        typeof error.error === 'object' &&
        'message' in error.error &&
        error.error.message
      ) {
        const message = error.error.message;

        return Array.isArray(message) ? message.join(', ') : String(message);
      }

      if (typeof error.error === 'string' && error.error.trim()) {
        return error.error;
      }

      return `Scraper request failed with status ${error.status}.`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Airtable scraper request failed.';
  }
}
