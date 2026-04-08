import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, createHmac } from 'node:crypto';
import puppeteer, { type Page } from 'puppeteer';
import { Model } from 'mongoose';
import { envBoolean, envNumber } from '../../../config/env.utils';
import { IntegrationsService } from '../../integrations/services/integrations.service';
import {
  BrowserCookie,
  IntegrationDocument,
} from '../../integrations/schemas/integration.schema';
import {
  AirtablePage,
  AirtablePageDocument,
} from '../schemas/airtable-page.schema';
import {
  AirtableRevisionHistory,
  AirtableRevisionHistoryDocument,
} from '../schemas/airtable-revision-history.schema';
import {
  ScrapeJob,
  ScrapeJobDocument,
} from '../schemas/scrape-job.schema';
import { AirtableSessionLoginDto } from '../dto/airtable-session-login.dto';
import { AirtableSessionValidationDto } from '../dto/airtable-session-validation.dto';
import { AirtableRevisionHistorySyncDto } from '../dto/airtable-revision-history-sync.dto';
import {
  AirtableRevisionParserService,
  ParsedRevisionHistoryChange,
} from './airtable-revision-parser.service';

class SessionExpiredError extends Error {}
class RetryableRevisionHistoryError extends Error {}

interface RecordTarget {
  baseId: string;
  tableId: string;
  recordId: string;
}

interface SessionCredentials {
  email: string;
  password: string;
  mfaCode?: string;
}

export interface CookieValidationResult extends Record<string, unknown> {
  valid: boolean;
  checkedAt: string;
  reason: string;
  cookieExpiresAt: Date | null;
  recordProbe?: RecordTarget | null;
}

@Injectable()
export class AirtableScraperService {
  constructor(
    private readonly configService: ConfigService,
    private readonly integrationsService: IntegrationsService,
    private readonly revisionParserService: AirtableRevisionParserService,
    @InjectModel(AirtablePage.name)
    private readonly airtablePageModel: Model<AirtablePageDocument>,
    @InjectModel(AirtableRevisionHistory.name)
    private readonly revisionHistoryModel: Model<AirtableRevisionHistoryDocument>,
    @InjectModel(ScrapeJob.name)
    private readonly scrapeJobModel: Model<ScrapeJobDocument>,
  ) {}

  async refreshSessionCookies(dto: AirtableSessionLoginDto = {}) {
    const integration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      dto.integrationKey ?? this.getDefaultIntegrationKey(),
    );
    const job = await this.createJob(integration, 'session_login', {
      targetEntity: 'integration',
      targetId: integration.integrationKey,
      metadata: {
        forced: dto.forceRelogin ?? false,
      },
    });

    try {
      const probeRecord = await this.findFirstStoredRecord(integration);
      const session = await this.ensureSessionCookies(integration, {
        forceRelogin: dto.forceRelogin ?? true,
        sessionLogin: dto,
        probeRecord,
      });

      await this.completeJob(job, {
        cookieCount: session.sessionCookies.length,
        cookieExpiresAt: session.cookieExpiresAt?.toISOString() ?? null,
      });

      return {
        status: 'ok',
        cookieCount: session.sessionCookies.length,
        cookieExpiresAt: session.cookieExpiresAt ?? null,
      };
    } catch (error) {
      await this.failJob(job, error);
      throw error;
    }
  }

  async validateSessionCookies(dto: AirtableSessionValidationDto = {}) {
    const integration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      dto.integrationKey ?? this.getDefaultIntegrationKey(),
    );
    const job = await this.createJob(integration, 'cookie_validation', {
      targetEntity: 'integration',
      targetId: integration.integrationKey,
      metadata: {
        baseId: dto.baseId,
        tableId: dto.tableId,
        recordId: dto.recordId,
      },
    });

    try {
      const probeRecord =
        dto.baseId && dto.tableId && dto.recordId
          ? {
              baseId: dto.baseId,
              tableId: dto.tableId,
              recordId: dto.recordId,
            }
          : await this.findFirstStoredRecord(integration);
      const result = await this.validateCookiesAgainstAirtable(
        integration.sessionCookies ?? [],
        probeRecord,
      );

      if (!result.valid && dto.forceRelogin) {
        await this.ensureSessionCookies(integration, {
          forceRelogin: true,
          probeRecord,
        });
      }

      await this.completeJob(job, result);

      return result;
    } catch (error) {
      await this.failJob(job, error);
      throw error;
    }
  }

  async scrapeRevisionHistory(dto: AirtableRevisionHistorySyncDto = {}) {
    const integration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      dto.integrationKey ?? this.getDefaultIntegrationKey(),
    );
    const records = await this.loadTargetRecords(integration, dto);

    if (!records.length) {
      throw new NotFoundException('No Airtable pages were found for revision history scraping.');
    }

    const job = await this.createJob(integration, 'revision_history', {
      targetEntity: 'integration',
      targetId: integration.integrationKey,
      recordsTotal: records.length,
      metadata: {
        baseId: dto.baseId ?? null,
        tableId: dto.tableId ?? null,
        recordId: dto.recordId ?? null,
        limit: dto.limit ?? this.getDefaultRevisionLimit(),
      },
    });

    try {
      let activeIntegration = await this.ensureSessionCookies(integration, {
        forceRelogin: dto.forceRelogin ?? false,
        sessionLogin: dto,
        probeRecord: records[0],
      });
      const concurrency = Math.min(
        Math.max(envNumber(this.configService.get<string>('SCRAPER_CONCURRENCY'), 2), 1),
        records.length,
      );
      let recordsProcessed = 0;
      let revisionsStored = 0;
      let statusChangesStored = 0;
      let assigneeChangesStored = 0;
      let cookieRefreshes = 0;
      let refreshTriggered = false;
      const queue = [...records];

      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (queue.length) {
            const record = queue.shift();

            if (!record) {
              return;
            }

            try {
              const result = await this.fetchRevisionHistoryWithRetry(
                activeIntegration,
                record,
                dto,
              );

              if (result.refreshedCookies) {
                activeIntegration = result.integration;
                cookieRefreshes += 1;
                refreshTriggered = true;
              }

              const changes = this.revisionParserService.parseRevisionHistory({
                html: result.html,
                sourceUrl: result.sourceUrl,
              });
              const storedCount = await this.persistRevisionChanges(
                activeIntegration,
                record,
                changes,
                result.sourceUrl,
              );

              revisionsStored += storedCount;
              statusChangesStored += changes.filter(
                (change) => change.changeType === 'status',
              ).length;
              assigneeChangesStored += changes.filter(
                (change) => change.changeType === 'assignee',
              ).length;
            } catch (error) {
              await this.appendJobError(job, error, {
                baseId: record.baseId,
                tableId: record.tableId,
                recordId: record.recordId,
              });
            } finally {
              recordsProcessed += 1;
              await this.updateJobProgress(job, recordsProcessed);
            }
          }
        }),
      );

      await this.completeJob(job, {
        recordsProcessed,
        recordsTotal: records.length,
        revisionsStored,
        statusChangesStored,
        assigneeChangesStored,
        cookieRefreshes,
        refreshedCookiesDuringRun: refreshTriggered,
      });

      return {
        status: 'completed',
        recordsProcessed,
        recordsTotal: records.length,
        revisionsStored,
        statusChangesStored,
        assigneeChangesStored,
        cookieRefreshes,
        jobId: String(job._id),
      };
    } catch (error) {
      await this.failJob(job, error);
      throw error;
    }
  }

  private async loadTargetRecords(
    integration: IntegrationDocument,
    dto: AirtableRevisionHistorySyncDto,
  ): Promise<RecordTarget[]> {
    const filters: Record<string, unknown> = {
      integrationId: integration._id,
    };

    if (dto.baseId) {
      filters.baseId = dto.baseId;
    }

    if (dto.tableId) {
      filters.tableId = dto.tableId;
    }

    if (dto.recordId) {
      filters.recordId = dto.recordId;
    } else if (dto.recordIds?.length) {
      filters.recordId = {
        $in: dto.recordIds,
      };
    }

    const limit = dto.limit ?? this.getDefaultRevisionLimit();
    const pages = await this.airtablePageModel
      .find(filters)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .select({ baseId: 1, tableId: 1, recordId: 1 })
      .exec();

    return pages.map((page) => ({
      baseId: page.baseId,
      tableId: page.tableId,
      recordId: page.recordId,
    }));
  }

  private async findFirstStoredRecord(
    integration: IntegrationDocument,
  ): Promise<RecordTarget | null> {
    const page = await this.airtablePageModel
      .findOne({ integrationId: integration._id })
      .sort({ updatedAt: -1, createdAt: -1 })
      .select({ baseId: 1, tableId: 1, recordId: 1 })
      .exec();

    if (!page) {
      return null;
    }

    return {
      baseId: page.baseId,
      tableId: page.tableId,
      recordId: page.recordId,
    };
  }

  private async ensureSessionCookies(
    integration: IntegrationDocument,
    input: {
      forceRelogin: boolean;
      sessionLogin?: Pick<
        AirtableSessionLoginDto | AirtableRevisionHistorySyncDto,
        'email' | 'password' | 'mfaCode'
      >;
      probeRecord?: RecordTarget | null;
    },
  ): Promise<IntegrationDocument> {
    if (!input.forceRelogin && integration.sessionCookies?.length) {
      const validation = await this.validateCookiesAgainstAirtable(
        integration.sessionCookies,
        input.probeRecord,
      );

      if (validation.valid) {
        return integration;
      }
    }

    const refreshedIntegration = await this.loginAndCaptureCookies(
      integration,
      this.resolveSessionCredentials(input.sessionLogin),
      input.probeRecord,
    );

    return refreshedIntegration;
  }

  private async validateCookiesAgainstAirtable(
    cookies: BrowserCookie[],
    probeRecord?: RecordTarget | null,
  ): Promise<CookieValidationResult> {
    if (!cookies.length) {
      return {
        valid: false,
        checkedAt: new Date().toISOString(),
        reason: 'No stored Airtable session cookies are available.',
        cookieExpiresAt: null,
        recordProbe: probeRecord ?? null,
      };
    }

    const validationUrl = probeRecord
      ? this.buildRevisionHistoryUrl(probeRecord)
      : this.getCookieValidationUrl();
    const response = await fetch(validationUrl, {
      method: 'GET',
      headers: {
        Cookie: this.buildCookieHeader(cookies),
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.getRequestTimeoutMs()),
    });
    const body = await response.text().catch(() => '');
    const valid =
      response.status < 400 &&
      !this.responseLooksUnauthenticated(response.status, body, response.headers.get('location'));

    return {
      valid,
      checkedAt: new Date().toISOString(),
      reason: valid
        ? 'Stored Airtable cookies are valid.'
        : 'Stored Airtable cookies are missing, expired, or redirected to login.',
      cookieExpiresAt: this.calculateCookieExpiry(cookies) ?? null,
      recordProbe: probeRecord ?? null,
    };
  }

  private async loginAndCaptureCookies(
    integration: IntegrationDocument,
    credentials: SessionCredentials,
    probeRecord?: RecordTarget | null,
  ): Promise<IntegrationDocument> {
    const launchTimeoutMs = this.getNavigationTimeoutMs();
    const browser = await puppeteer.launch({
      headless: envBoolean(this.configService.get<string>('PUPPETEER_HEADLESS'), true),
      executablePath: this.configService.get<string>('PUPPETEER_EXECUTABLE_PATH') || undefined,
      timeout: launchTimeoutMs,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
      const page = await browser.newPage();
      const loginUrl = this.getLoginUrl();
      const slowMoMs = envNumber(this.configService.get<string>('PUPPETEER_SLOW_MO_MS'), 0);

      page.setDefaultTimeout(this.getDefaultTimeoutMs());
      page.setDefaultNavigationTimeout(this.getNavigationTimeoutMs());

      await page.goto(loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.getNavigationTimeoutMs(),
      });
      await this.sleep(slowMoMs);
      await this.completeCredentialFlow(page, credentials, slowMoMs);
      await this.completeMfaFlow(page, credentials.mfaCode, slowMoMs);
      await this.waitForAuthenticatedState(page);

      const cookies = (await page.browserContext().cookies()).map((cookie) =>
        this.mapPuppeteerCookie(cookie),
      );

      if (!cookies.length) {
        throw new UnauthorizedException(
          'Airtable login completed without returning any session cookies.',
        );
      }

      const validation = await this.validateCookiesAgainstAirtable(cookies, probeRecord);

      if (!validation.valid) {
        throw new UnauthorizedException(validation.reason);
      }

      return this.integrationsService.storeSessionCookies(integration, {
        cookies,
        expiresAt: validation.cookieExpiresAt ?? undefined,
      });
    } finally {
      await browser.close();
    }
  }

  private async completeCredentialFlow(
    page: Page,
    credentials: SessionCredentials,
    slowMoMs: number,
  ): Promise<void> {
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[autocomplete="username"]',
    ];
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
    ];
    const submitSelectors = [
      'button[type="submit"]',
      'button[data-testid*="submit"]',
      'button[data-test-id*="submit"]',
      'button',
    ];

    await this.fillFirstAvailable(page, emailSelectors, credentials.email);
    await this.sleep(slowMoMs);
    await this.fillFirstAvailable(page, passwordSelectors, credentials.password);
    await this.sleep(slowMoMs);
    await this.clickFirstAvailable(page, submitSelectors);
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: this.getNavigationTimeoutMs(),
    }).catch(() => undefined);

    const passwordVisible = await this.hasAnySelector(page, passwordSelectors);

    if (passwordVisible) {
      await this.fillFirstAvailable(page, passwordSelectors, credentials.password);
      await this.sleep(slowMoMs);
      await this.clickFirstAvailable(page, submitSelectors);
      await page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: this.getNavigationTimeoutMs(),
      }).catch(() => undefined);
    }
  }

  private async completeMfaFlow(
    page: Page,
    mfaCode: string | undefined,
    slowMoMs: number,
  ): Promise<void> {
    const mfaSelectors = [
      'input[autocomplete="one-time-code"]',
      'input[name*="code"]',
      'input[id*="code"]',
      'input[inputmode="numeric"]',
    ];

    if (!(await this.hasAnySelector(page, mfaSelectors))) {
      return;
    }

    if (!mfaCode) {
      throw new BadRequestException(
        'Airtable MFA is required. Pass the MFA code from the frontend or configure AIRTABLE_MFA_SECRET.',
      );
    }

    const individualInputs = await page.$$('input[inputmode="numeric"]');

    if (individualInputs.length > 1) {
      const digits = mfaCode.replace(/\s+/g, '').split('');

      for (let index = 0; index < individualInputs.length && index < digits.length; index += 1) {
        const input = individualInputs[index];

        await input.click({ clickCount: 3 });
        await input.type(digits[index], { delay: 20 });
      }
    } else {
      await this.fillFirstAvailable(page, mfaSelectors, mfaCode.replace(/\s+/g, ''));
    }

    await this.sleep(slowMoMs);
    await this.clickFirstAvailable(page, ['button[type="submit"]', 'button']);
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: this.getNavigationTimeoutMs(),
    }).catch(() => undefined);
  }

  private async waitForAuthenticatedState(page: Page): Promise<void> {
    const successPattern =
      this.configService.get<string>('AIRTABLE_LOGIN_SUCCESS_URL_PATTERN') ?? '/app';
    const timeoutAt = Date.now() + this.getNavigationTimeoutMs();

    while (Date.now() < timeoutAt) {
      const currentUrl = page.url();

      if (!/login/i.test(currentUrl) || currentUrl.includes(successPattern)) {
        return;
      }

      await this.sleep(500);
    }

    throw new UnauthorizedException(
      'Airtable session login did not reach an authenticated state before timing out.',
    );
  }

  private async fetchRevisionHistoryWithRetry(
    integration: IntegrationDocument,
    record: RecordTarget,
    dto: AirtableRevisionHistorySyncDto,
  ): Promise<{
    html: string;
    sourceUrl: string;
    integration: IntegrationDocument;
    refreshedCookies: boolean;
  }> {
    let activeIntegration = integration;
    let refreshedCookies = false;
    const maxAttempts = Math.max(
      envNumber(
        this.configService.get<string>('AIRTABLE_REVISION_HISTORY_MAX_ATTEMPTS'),
        4,
      ),
      1,
    );

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const html = await this.fetchRevisionHistoryHtml(activeIntegration.sessionCookies, record);

        return {
          html,
          sourceUrl: this.buildRevisionHistoryUrl(record),
          integration: activeIntegration,
          refreshedCookies,
        };
      } catch (error) {
        if (error instanceof SessionExpiredError && !refreshedCookies) {
          activeIntegration = await this.loginAndCaptureCookies(
            activeIntegration,
            this.resolveSessionCredentials(dto),
            record,
          );
          refreshedCookies = true;
          continue;
        }

        if (attempt < maxAttempts && error instanceof RetryableRevisionHistoryError) {
          await this.sleep(this.getRetryDelayMs(attempt));
          continue;
        }

        throw error;
      }
    }

    throw new ServiceUnavailableException(
      `Unable to fetch Airtable revision history for record ${record.recordId}.`,
    );
  }

  private async fetchRevisionHistoryHtml(
    cookies: BrowserCookie[],
    record: RecordTarget,
  ): Promise<string> {
    const url = this.buildRevisionHistoryUrl(record);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Cookie: this.buildCookieHeader(cookies),
        Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(this.getRequestTimeoutMs()),
    });
    const body = await response.text();

    if (this.responseLooksUnauthenticated(response.status, body, response.headers.get('location'))) {
      throw new SessionExpiredError(
        'Stored Airtable cookies are invalid for the revision history endpoint.',
      );
    }

    if (response.status === 429 || response.status >= 500) {
      throw new RetryableRevisionHistoryError(
        `Airtable revision history endpoint returned ${response.status}.`,
      );
    }

    if (!response.ok) {
      throw new ServiceUnavailableException(
        `Airtable revision history endpoint returned ${response.status}.`,
      );
    }

    return body;
  }

  private async persistRevisionChanges(
    integration: IntegrationDocument,
    record: RecordTarget,
    changes: ParsedRevisionHistoryChange[],
    sourceUrl: string,
  ): Promise<number> {
    if (!changes.length) {
      return 0;
    }

    const operations = changes.map((change) => ({
      updateOne: {
        filter: {
          dedupeKey: this.buildRevisionDedupeKey(record, change),
        },
        update: {
          $set: {
            integrationId: integration._id,
            baseId: record.baseId,
            tableId: record.tableId,
            recordId: record.recordId,
            changeType: change.changeType,
            fieldName: change.fieldName,
            oldValue: change.oldValue,
            newValue: change.newValue,
            changedAt: change.changedAt,
            changedBy: change.changedBy,
            dedupeKey: this.buildRevisionDedupeKey(record, change),
            sourceUrl,
            syncedAt: new Date(),
            rawHtmlSnippet: change.rawHtmlSnippet,
          },
        },
        upsert: true,
      },
    }));

    await this.revisionHistoryModel.bulkWrite(operations as never, { ordered: false });

    return changes.length;
  }

  private buildRevisionDedupeKey(
    record: RecordTarget,
    change: ParsedRevisionHistoryChange,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          baseId: record.baseId,
          tableId: record.tableId,
          recordId: record.recordId,
          changeType: change.changeType,
          fieldName: change.fieldName,
          changedAt: change.changedAt.toISOString(),
          oldValue: change.oldValue ?? null,
          newValue: change.newValue ?? null,
        }),
      )
      .digest('hex');
  }

  private resolveSessionCredentials(
    input?: Pick<
      AirtableSessionLoginDto | AirtableRevisionHistorySyncDto,
      'email' | 'password' | 'mfaCode'
    >,
  ): SessionCredentials {
    const email = input?.email ?? this.configService.get<string>('AIRTABLE_SESSION_EMAIL');
    const password =
      input?.password ?? this.configService.get<string>('AIRTABLE_SESSION_PASSWORD');
    const mfaCode =
      input?.mfaCode ??
      this.generateTotpCode(this.configService.get<string>('AIRTABLE_MFA_SECRET'));

    if (!email || !password) {
      throw new BadRequestException(
        'Airtable session email and password are required to capture revision-history cookies.',
      );
    }

    return {
      email,
      password,
      mfaCode,
    };
  }

  private buildRevisionHistoryUrl(record: RecordTarget): string {
    const template =
      this.configService.get<string>('AIRTABLE_REVISION_HISTORY_URL_TEMPLATE') ??
      'https://airtable.com/v0.3/application/{baseId}/readRowActivitiesAndComments?tableId={tableId}&rowId={recordId}';

    return template
      .replaceAll('{baseId}', encodeURIComponent(record.baseId))
      .replaceAll('{tableId}', encodeURIComponent(record.tableId))
      .replaceAll('{recordId}', encodeURIComponent(record.recordId));
  }

  private buildCookieHeader(cookies: BrowserCookie[]): string {
    return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
  }

  private mapPuppeteerCookie(cookie: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: string;
  }): BrowserCookie {
    return {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure ?? false,
      sameSite: cookie.sameSite,
    };
  }

  private calculateCookieExpiry(cookies: BrowserCookie[]): Date | undefined {
    const expiryValues = cookies
      .map((cookie) => cookie.expires)
      .filter((value): value is number => typeof value === 'number' && value > 0)
      .map((value) => new Date(value * 1000))
      .filter((value) => !Number.isNaN(value.getTime()));

    if (expiryValues.length) {
      return expiryValues.sort((left, right) => left.getTime() - right.getTime())[0];
    }

    return new Date(
      Date.now() + envNumber(this.configService.get<string>('SCRAPER_COOKIE_TTL_HOURS'), 12) * 3_600_000,
    );
  }

  private responseLooksUnauthenticated(
    status: number,
    body: string,
    locationHeader: string | null,
  ): boolean {
    return (
      status === 401 ||
      status === 403 ||
      status === 302 ||
      Boolean(locationHeader && /login/i.test(locationHeader)) ||
      /sign in|log in|two-factor|one-time code/i.test(body)
    );
  }

  private async fillFirstAvailable(
    page: Page,
    selectors: string[],
    value: string,
  ): Promise<boolean> {
    for (const selector of selectors) {
      const input = await page.$(selector);

      if (!input) {
        continue;
      }

      await input.click({ clickCount: 3 });
      await input.type(value, { delay: 20 });

      return true;
    }

    return false;
  }

  private async clickFirstAvailable(page: Page, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      const element = await page.$(selector);

      if (!element) {
        continue;
      }

      await element.click();

      return true;
    }

    await page.keyboard.press('Enter');

    return true;
  }

  private async hasAnySelector(page: Page, selectors: string[]): Promise<boolean> {
    for (const selector of selectors) {
      if (await page.$(selector)) {
        return true;
      }
    }

    return false;
  }

  private getLoginUrl(): string {
    return this.configService.get<string>('AIRTABLE_LOGIN_URL') ?? 'https://airtable.com/login';
  }

  private getCookieValidationUrl(): string {
    return this.configService.get<string>('AIRTABLE_COOKIE_VALIDATION_URL') ?? 'https://airtable.com/';
  }

  private getRequestTimeoutMs(): number {
    return envNumber(
      this.configService.get<string>('AIRTABLE_REVISION_HISTORY_REQUEST_TIMEOUT_MS'),
      30_000,
    );
  }

  private getNavigationTimeoutMs(): number {
    return envNumber(
      this.configService.get<string>('PUPPETEER_NAVIGATION_TIMEOUT_MS'),
      45_000,
    );
  }

  private getDefaultTimeoutMs(): number {
    return envNumber(
      this.configService.get<string>('PUPPETEER_DEFAULT_TIMEOUT_MS'),
      30_000,
    );
  }

  private getDefaultRevisionLimit(): number {
    return envNumber(
      this.configService.get<string>('AIRTABLE_REVISION_HISTORY_PAGE_LIMIT'),
      200,
    );
  }

  private getDefaultIntegrationKey(): string {
    return this.configService.get<string>('AIRTABLE_DEFAULT_INTEGRATION_KEY') ?? 'default';
  }

  private getRetryDelayMs(attempt: number): number {
    const baseDelay = envNumber(
      this.configService.get<string>('AIRTABLE_REVISION_HISTORY_BACKOFF_MS'),
      1000,
    );

    return baseDelay * attempt;
  }

  private async createJob(
    integration: IntegrationDocument,
    jobType: 'revision_history' | 'cookie_validation' | 'session_login',
    input: {
      targetEntity: 'integration' | 'base' | 'table' | 'record';
      targetId: string;
      baseId?: string | null;
      tableId?: string | null;
      recordId?: string | null;
      recordsTotal?: number;
      metadata?: Record<string, unknown>;
    },
  ): Promise<ScrapeJobDocument> {
    const job = new this.scrapeJobModel({
      integrationId: integration._id,
      jobType,
      status: 'running',
      targetEntity: input.targetEntity,
      targetId: input.targetId,
      baseId: input.baseId ?? undefined,
      tableId: input.tableId ?? undefined,
      recordId: input.recordId ?? undefined,
      queuedAt: new Date(),
      startedAt: new Date(),
      lastHeartbeatAt: new Date(),
      attempt: 1,
      maxAttempts: Math.max(
        envNumber(
          this.configService.get<string>('AIRTABLE_REVISION_HISTORY_MAX_ATTEMPTS'),
          4,
        ),
        1,
      ),
      recordsProcessed: 0,
      recordsTotal: input.recordsTotal ?? 0,
      metadata: input.metadata ?? {},
    });

    return job.save();
  }

  private async updateJobProgress(
    job: ScrapeJobDocument,
    recordsProcessed: number,
  ): Promise<void> {
    job.recordsProcessed = recordsProcessed;
    job.lastHeartbeatAt = new Date();

    await job.save();
  }

  private async appendJobError(
    job: ScrapeJobDocument,
    error: unknown,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unexpected scraper error.';

    job.lastError = message;
    job.lastHeartbeatAt = new Date();
    job.errorHistory.push({
      message,
      at: new Date(),
      details,
    });

    await job.save();
  }

  private async completeJob(
    job: ScrapeJobDocument,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    job.status = 'completed';
    job.finishedAt = new Date();
    job.lastHeartbeatAt = new Date();
    job.metadata = {
      ...(job.metadata ?? {}),
      ...metadata,
    };

    await job.save();
  }

  private async failJob(job: ScrapeJobDocument, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unexpected scraper failure.';

    job.status = 'failed';
    job.finishedAt = new Date();
    job.lastHeartbeatAt = new Date();
    job.lastError = message;
    job.errorHistory.push({
      message,
      at: new Date(),
      details: {},
    });

    await job.save();
  }

  private generateTotpCode(secret: string | undefined): string | undefined {
    if (!secret) {
      return undefined;
    }

    const normalizedSecret = secret.replace(/\s+/g, '').toUpperCase();
    const key = this.decodeBase32(normalizedSecret);
    const timeStep = Math.floor(Date.now() / 1000 / 30);
    const buffer = Buffer.alloc(8);

    buffer.writeUInt32BE(Math.floor(timeStep / 0x100000000), 0);
    buffer.writeUInt32BE(timeStep >>> 0, 4);

    const digest = createHmac('sha1', key).update(buffer).digest();
    const offset = digest[digest.length - 1] & 0x0f;
    const binary =
      ((digest[offset] & 0x7f) << 24) |
      ((digest[offset + 1] & 0xff) << 16) |
      ((digest[offset + 2] & 0xff) << 8) |
      (digest[offset + 3] & 0xff);

    return String(binary % 1_000_000).padStart(6, '0');
  }

  private decodeBase32(value: string): Buffer {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    let bits = '';

    for (const character of value.replace(/=+$/g, '')) {
      const index = alphabet.indexOf(character);

      if (index < 0) {
        throw new BadRequestException('AIRTABLE_MFA_SECRET must be a valid Base32 string.');
      }

      bits += index.toString(2).padStart(5, '0');
    }

    const bytes: number[] = [];

    for (let index = 0; index + 8 <= bits.length; index += 8) {
      bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
    }

    return Buffer.from(bytes);
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
