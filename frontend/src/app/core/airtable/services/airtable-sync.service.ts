import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { clientAppConfig } from '../../config/client-app-config';
import { AirtableSyncSummary } from '../models/airtable-sync-result.model';

@Injectable({ providedIn: 'root' })
export class AirtableSyncService {
  private readonly httpClient = inject(HttpClient);

  async runFullSync(): Promise<AirtableSyncSummary> {
    try {
      return await firstValueFrom(
        this.httpClient.post<AirtableSyncSummary>(
          `${clientAppConfig.apiBaseUrl}/integrations/airtable/sync`,
          {
            integrationKey: clientAppConfig.airtableIntegrationKey,
            includeRecords: true,
            includeUsers: true,
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

      return `Sync request failed with status ${error.status}.`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Airtable sync failed.';
  }
}
