import {
  Injectable,
  InternalServerErrorException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { envNumber } from '../../../config/env.utils';
import { AirtableOAuthService } from './airtable-oauth.service';

interface AirtablePagedResponse<T> {
  records?: T[];
  bases?: T[];
  tables?: T[];
  offset?: string;
}

export interface AirtableBasePayload {
  id: string;
  name: string;
  permissionLevel?: string;
  workspaceId?: string;
  workspaceName?: string;
  [key: string]: unknown;
}

export interface AirtableTablePayload {
  id: string;
  name: string;
  description?: string;
  primaryFieldId?: string;
  fields?: Array<Record<string, unknown>>;
  views?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

export interface AirtableRecordPayload {
  id: string;
  createdTime?: string;
  fields?: Record<string, unknown>;
  commentCount?: number;
  [key: string]: unknown;
}

@Injectable()
export class AirtableApiService {
  private nextAllowedRequestAt = 0;

  constructor(
    private readonly configService: ConfigService,
    private readonly airtableOAuthService: AirtableOAuthService,
  ) {}

  async listBases(integrationKey?: string): Promise<AirtableBasePayload[]> {
    const response = await this.requestJson<AirtablePagedResponse<AirtableBasePayload>>(
      this.buildMetadataUrl('/bases'),
      {
        integrationKey,
      },
    );

    return response.bases ?? [];
  }

  async getBaseTables(baseId: string, integrationKey?: string): Promise<AirtableTablePayload[]> {
    const response = await this.requestJson<AirtablePagedResponse<AirtableTablePayload>>(
      this.buildMetadataUrl(`/bases/${encodeURIComponent(baseId)}/tables`),
      {
        integrationKey,
      },
    );

    return response.tables ?? [];
  }

  async listAllRecords(
    baseId: string,
    tableId: string,
    integrationKey?: string,
  ): Promise<AirtableRecordPayload[]> {
    const records: AirtableRecordPayload[] = [];
    let offset: string | undefined;
    const pageSize = Math.min(
      envNumber(this.configService.get<string>('AIRTABLE_PAGE_SIZE'), 100),
      100,
    );

    do {
      const endpoint = this.buildDataUrl(
        `/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`,
      );
      const response = await this.requestJson<AirtablePagedResponse<AirtableRecordPayload>>(
        endpoint,
        {
          integrationKey,
          query: {
            pageSize,
            ...(offset ? { offset } : {}),
          },
        },
      );

      records.push(...(response.records ?? []));
      offset = response.offset;
    } while (offset);

    return records;
  }

  private async requestJson<T>(
    input: string,
    options: {
      integrationKey?: string;
      method?: 'GET' | 'POST' | 'PATCH';
      query?: Record<string, string | number | boolean | undefined>;
      body?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    const accessToken = await this.airtableOAuthService.getValidAccessToken(
      options.integrationKey,
    );
    const url = new URL(input);
    const maxRetries = envNumber(
      this.configService.get<string>('AIRTABLE_SYNC_MAX_RETRIES'),
      2,
    );
    const timeoutMs = envNumber(
      this.configService.get<string>('AIRTABLE_REQUEST_TIMEOUT_MS'),
      30_000,
    );

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      await this.throttle();

      const response = await fetch(url, {
        method: options.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...options.headers,
        },
        body: options.body,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (response.ok) {
        return (await response.json()) as T;
      }

      const responseBody = (await response.json().catch(() => null)) as
        | { error?: { message?: string; type?: string } | string }
        | null;
      const responseMessage =
        typeof responseBody?.error === 'string'
          ? responseBody.error
          : responseBody?.error?.message;

      if (response.status === 401) {
        throw new UnauthorizedException(responseMessage ?? 'Airtable authorization failed.');
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt < maxRetries) {
          const retryAfter = Number(response.headers.get('retry-after') ?? 0);
          const backoffDelay = retryAfter > 0 ? retryAfter * 1000 : 500 * (attempt + 1);

          await this.sleep(backoffDelay);

          continue;
        }

        throw new ServiceUnavailableException(
          responseMessage ?? 'Airtable is rate limiting or temporarily unavailable.',
        );
      }

      throw new InternalServerErrorException(
        responseMessage ?? `Airtable request failed with status ${response.status}.`,
      );
    }

    throw new ServiceUnavailableException('Airtable request could not be completed.');
  }

  private buildMetadataUrl(path: string): string {
    const baseUrl =
      this.configService.get<string>('AIRTABLE_METADATA_BASE_URL') ??
      'https://api.airtable.com/v0/meta';

    return `${baseUrl.replace(/\/$/, '')}${path}`;
  }

  private buildDataUrl(path: string): string {
    const baseUrl =
      this.configService.get<string>('AIRTABLE_API_BASE_URL') ?? 'https://api.airtable.com';

    return `${baseUrl.replace(/\/$/, '')}/v0${path}`;
  }

  private async throttle(): Promise<void> {
    const requestsPerSecond = Math.max(
      envNumber(this.configService.get<string>('AIRTABLE_RATE_LIMIT_PER_SECOND'), 5),
      1,
    );
    const minimumIntervalMs = Math.ceil(1000 / requestsPerSecond);
    const now = Date.now();
    const waitMs = Math.max(this.nextAllowedRequestAt - now, 0);

    this.nextAllowedRequestAt = Math.max(this.nextAllowedRequestAt, now) + minimumIntervalMs;

    if (waitMs > 0) {
      await this.sleep(waitMs);
    }
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
