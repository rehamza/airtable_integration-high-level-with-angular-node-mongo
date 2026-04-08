import { HttpClient, HttpErrorResponse, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { clientAppConfig } from '../../config/client-app-config';
import {
  AirtableGridEntity,
  GridDataResponse,
  GridOptionsResponse,
} from '../models/grid.models';

export interface GridDataRequest {
  baseId?: string;
  entity: AirtableGridEntity;
  processedEntity?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  page: number;
  pageSize: number;
  filterModel?: Record<string, unknown>;
}

@Injectable({ providedIn: 'root' })
export class GridDataService {
  private readonly httpClient = inject(HttpClient);

  async getOptions(input: {
    baseId?: string;
    entity?: AirtableGridEntity;
  } = {}): Promise<GridOptionsResponse> {
    try {
      let params = new HttpParams().set(
        'integrationKey',
        clientAppConfig.airtableIntegrationKey,
      );

      if (input.baseId) {
        params = params.set('baseId', input.baseId);
      }

      if (input.entity) {
        params = params.set('entity', input.entity);
      }

      return await firstValueFrom(
        this.httpClient.get<GridOptionsResponse>(
          `${clientAppConfig.apiBaseUrl}/grid/options`,
          { params },
        ),
      );
    } catch (error) {
      throw new Error(this.describeHttpError(error));
    }
  }

  async getGridData(input: GridDataRequest): Promise<GridDataResponse> {
    try {
      let params = new HttpParams()
        .set('integrationKey', clientAppConfig.airtableIntegrationKey)
        .set('entity', input.entity)
        .set('page', String(input.page))
        .set('pageSize', String(input.pageSize));

      if (input.baseId) {
        params = params.set('baseId', input.baseId);
      }

      if (input.processedEntity) {
        params = params.set('processedEntity', input.processedEntity);
      }

      if (input.search?.trim()) {
        params = params.set('search', input.search.trim());
      }

      if (input.sortBy?.trim()) {
        params = params.set('sortBy', input.sortBy.trim());
      }

      if (input.sortOrder) {
        params = params.set('sortOrder', input.sortOrder);
      }

      if (input.filterModel && Object.keys(input.filterModel).length > 0) {
        params = params.set('filterModel', JSON.stringify(input.filterModel));
      }

      return await firstValueFrom(
        this.httpClient.get<GridDataResponse>(
          `${clientAppConfig.apiBaseUrl}/grid/data`,
          { params },
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

      if (error.status === 0) {
        return 'The grid backend is unreachable. Start the Nest API on port 3007.';
      }

      return `Grid request failed with status ${error.status}.`;
    }

    if (error instanceof Error) {
      return error.message;
    }

    return 'Grid request failed.';
  }
}
