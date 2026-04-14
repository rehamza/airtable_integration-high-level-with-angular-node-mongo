import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
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
  AirtableTable,
  AirtableTableDocument,
} from '../schemas/airtable-table.schema';
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
  private readonly logger = new Logger(AirtableScraperService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly integrationsService: IntegrationsService,
    private readonly revisionParserService: AirtableRevisionParserService,
    @InjectModel(AirtablePage.name)
    private readonly airtablePageModel: Model<AirtablePageDocument>,
    @InjectModel(AirtableTable.name)
    private readonly airtableTableModel: Model<AirtableTableDocument>,
    @InjectModel(AirtableRevisionHistory.name)
    private readonly revisionHistoryModel: Model<AirtableRevisionHistoryDocument>,
    @InjectModel(ScrapeJob.name)
    private readonly scrapeJobModel: Model<ScrapeJobDocument>,
  ) {}

  async refreshSessionCookies(dto: AirtableSessionLoginDto = {}) {
    this.logger.log(
      `Session cookie refresh started for integration="${dto.integrationKey ?? this.getDefaultIntegrationKey()}" forceRelogin=${dto.forceRelogin ?? true}`,
    );
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
      const session = await this.ensureSessionCookies(integration, {
        forceRelogin: dto.forceRelogin ?? true,
        sessionLogin: dto,
        probeRecord: null,
      });

      await this.completeJob(job, {
        cookieCount: session.sessionCookies.length,
        cookieExpiresAt: session.cookieExpiresAt?.toISOString() ?? null,
      });
      this.logger.log(
        `Session cookie refresh completed for integration="${integration.integrationKey}" cookieCount=${session.sessionCookies.length} cookieExpiresAt=${session.cookieExpiresAt?.toISOString() ?? 'null'}`,
      );

      return {
        status: 'ok',
        cookieCount: session.sessionCookies.length,
        cookieExpiresAt: session.cookieExpiresAt ?? null,
      };
    } catch (error) {
      await this.safeFailJob(job, error);
      this.logger.error(
        `Session cookie refresh failed for integration="${integration.integrationKey}"`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async validateSessionCookies(dto: AirtableSessionValidationDto = {}) {
    this.logger.log(
      `Cookie validation started for integration="${dto.integrationKey ?? this.getDefaultIntegrationKey()}" baseId=${dto.baseId ?? 'n/a'} tableId=${dto.tableId ?? 'n/a'} recordId=${dto.recordId ?? 'n/a'} forceRelogin=${dto.forceRelogin ?? false}`,
    );
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
          : null;
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
      this.logger.log(
        `Cookie validation completed for integration="${integration.integrationKey}" valid=${result.valid} reason="${result.reason}"`,
      );

      return result;
    } catch (error) {
      await this.safeFailJob(job, error);
      this.logger.error(
        `Cookie validation failed for integration="${integration.integrationKey}"`,
        error instanceof Error ? error.stack : undefined,
      );
      throw error;
    }
  }

  async scrapeRevisionHistory(dto: AirtableRevisionHistorySyncDto = {}) {
    this.logger.log(
      `Revision history scrape started for integration="${dto.integrationKey ?? this.getDefaultIntegrationKey()}" baseId=${dto.baseId ?? 'n/a'} tableId=${dto.tableId ?? 'n/a'} recordId=${dto.recordId ?? 'n/a'} limit=${dto.limit ?? this.getDefaultRevisionLimit()} forceRelogin=${dto.forceRelogin ?? false}`,
    );
    const integration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      dto.integrationKey ?? this.getDefaultIntegrationKey(),
    );
    const records = await this.loadTargetRecords(integration, dto);
    this.logger.log(
      `Loaded ${records.length} Airtable page record(s) for revision-history scraping on integration="${integration.integrationKey}"`,
    );

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
        probeRecord: null,
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
      const tableNameCache = new Map<string, string | undefined>();
      const firstRecord = queue.shift();
      this.logger.log(
        `Revision history worker pool starting for integration="${integration.integrationKey}" concurrency=${concurrency} queueSize=${queue.length}`,
      );

      if (firstRecord) {
        this.logger.log(
          `Running revision-history preflight for first record baseId=${firstRecord.baseId} tableId=${firstRecord.tableId} recordId=${firstRecord.recordId}`,
        );
        const firstResult = await this.fetchRevisionHistoryWithRetry(
          activeIntegration,
          firstRecord,
          dto,
        );

        if (firstResult.refreshedCookies) {
          activeIntegration = firstResult.integration;
          cookieRefreshes += 1;
          refreshTriggered = true;
        }

        const firstChanges =
          firstResult.parsedChanges ??
          this.revisionParserService.parseRevisionHistory({
            html: firstResult.html,
            sourceUrl: firstResult.sourceUrl,
          });
        this.logger.debug(
          `Preflight parsed ${firstChanges.length} change(s) for recordId=${firstRecord.recordId}`,
        );
        const firstStoredCount = await this.persistRevisionChanges(
          activeIntegration,
          firstRecord,
          firstChanges,
          firstResult.sourceUrl,
          tableNameCache,
        );
        this.logger.debug(
          `Preflight persisted ${firstStoredCount} change(s) for recordId=${firstRecord.recordId}`,
        );
        revisionsStored += firstStoredCount;
        statusChangesStored += firstChanges.filter(
          (change) => change.changeType === 'status',
        ).length;
        assigneeChangesStored += firstChanges.filter(
          (change) => change.changeType === 'assignee',
        ).length;
        recordsProcessed += 1;
        await this.safeUpdateJobProgress(job, recordsProcessed);
      }

      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (queue.length) {
            const record = queue.shift();

            if (!record) {
              return;
            }

            try {
              this.logger.debug(
                `Fetching revision history for baseId=${record.baseId} tableId=${record.tableId} recordId=${record.recordId}`,
              );
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

              const changes =
                result.parsedChanges ??
                this.revisionParserService.parseRevisionHistory({
                  html: result.html,
                  sourceUrl: result.sourceUrl,
                });
              this.logger.debug(
                `Parsed ${changes.length} change(s) for recordId=${record.recordId}: ${JSON.stringify(
                  changes.map((change) => ({
                    activityId: change.activityId ?? null,
                    changeType: change.changeType,
                    fieldName: change.fieldName,
                    oldValue: change.oldValue ?? null,
                    newValue: change.newValue ?? null,
                    changedAt: change.changedAt.toISOString(),
                    changedBy: change.changedBy,
                  })),
                )}`,
              );
              const storedCount = await this.persistRevisionChanges(
                activeIntegration,
                record,
                changes,
                result.sourceUrl,
                tableNameCache,
              );
              this.logger.debug(
                `Persisted ${storedCount} revision-history change(s) for recordId=${record.recordId}`,
              );

              revisionsStored += storedCount;
              statusChangesStored += changes.filter(
                (change) => change.changeType === 'status',
              ).length;
              assigneeChangesStored += changes.filter(
                (change) => change.changeType === 'assignee',
              ).length;
            } catch (error) {
              this.logger.error(
                `Revision history fetch failed for baseId=${record.baseId} tableId=${record.tableId} recordId=${record.recordId}`,
                error instanceof Error ? error.stack : undefined,
              );
              await this.safeAppendJobError(job, error, {
                baseId: record.baseId,
                tableId: record.tableId,
                recordId: record.recordId,
              });
            } finally {
              recordsProcessed += 1;
              await this.safeUpdateJobProgress(job, recordsProcessed);
            }
          }
        }),
      );

      await this.safeCompleteJob(job, {
        recordsProcessed,
        recordsTotal: records.length,
        revisionsStored,
        statusChangesStored,
        assigneeChangesStored,
        cookieRefreshes,
        refreshedCookiesDuringRun: refreshTriggered,
      });
      this.logger.log(
        `Revision history scrape completed for integration="${integration.integrationKey}" recordsProcessed=${recordsProcessed}/${records.length} revisionsStored=${revisionsStored} statusChangesStored=${statusChangesStored} assigneeChangesStored=${assigneeChangesStored} cookieRefreshes=${cookieRefreshes}`,
      );

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
      await this.safeFailJob(job, error);
      this.logger.error(
        `Revision history scrape failed for integration="${integration.integrationKey}"`,
        error instanceof Error ? error.stack : undefined,
      );
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
    this.logger.debug(
      `Loading target records for integration="${integration.integrationKey}" with filters=${JSON.stringify({
        baseId: dto.baseId ?? null,
        tableId: dto.tableId ?? null,
        recordId: dto.recordId ?? null,
        recordIds: dto.recordIds ?? null,
        limit,
      })}`,
    );
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
    this.logger.debug(
      `Ensuring session cookies for integration="${integration.integrationKey}" forceRelogin=${input.forceRelogin} storedCookieCount=${integration.sessionCookies?.length ?? 0}`,
    );
    if (!input.forceRelogin && integration.sessionCookies?.length) {
      const validation = await this.validateCookiesAgainstAirtable(
        integration.sessionCookies,
        input.probeRecord,
      );
      this.logger.debug(
        `Stored cookie validation result for integration="${integration.integrationKey}" valid=${validation.valid} reason="${validation.reason}"`,
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
      this.logger.warn('Cookie validation skipped because no stored session cookies were available.');
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
    this.logger.debug(`Validating Airtable cookies against url="${validationUrl}" cookieCount=${cookies.length}`);
    const response = await fetch(validationUrl, {
      method: 'GET',
      headers: this.buildAirtableHttpHeaders(cookies, validationUrl),
      redirect: 'manual',
      signal: AbortSignal.timeout(this.getRequestTimeoutMs()),
    });
    const body = await response.text().catch(() => '');
    const valid =
      response.status < 400 &&
      !this.responseLooksUnauthenticated(response.status, body, response.headers.get('location'));
    this.logger.debug(
      `Cookie validation response status=${response.status} valid=${valid} location=${response.headers.get('location') ?? 'n/a'}`,
    );

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
    const executablePath = this.resolveBrowserExecutablePath();
    this.logger.log(
      `Launching browser for Airtable session login integration="${integration.integrationKey}" email="${credentials.email}" executablePath="${executablePath ?? 'default'}"`,
    );
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

    try {
      browser = await puppeteer.launch({
        headless: envBoolean(this.configService.get<string>('PUPPETEER_HEADLESS'), true),
        executablePath,
        timeout: launchTimeoutMs,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });
    } catch (error) {
      throw new ServiceUnavailableException(
        this.describeBrowserLaunchFailure(error, executablePath),
      );
    }

    try {
      const page = await browser.newPage();
      const loginUrl = this.getLoginUrl();
      const slowMoMs = envNumber(this.configService.get<string>('PUPPETEER_SLOW_MO_MS'), 0);
      const interactionTimeoutMs = Math.min(this.getDefaultTimeoutMs(), 20_000);

      page.setDefaultTimeout(this.getDefaultTimeoutMs());
      page.setDefaultNavigationTimeout(this.getNavigationTimeoutMs());
      await page.setViewport({ width: 1440, height: 1024 });
      await page.setUserAgent(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
      );

      await page.goto(loginUrl, {
        waitUntil: 'networkidle2',
        timeout: this.getNavigationTimeoutMs(),
      });
      this.logger.debug(`Opened Airtable login page url="${loginUrl}"`);
      await this.sleep(slowMoMs);
      await this.completeCredentialFlow(page, credentials, slowMoMs, interactionTimeoutMs);
      this.logger.debug(`Credential flow completed for email="${credentials.email}"`);
      await this.completeMfaFlow(page, credentials.mfaCode, slowMoMs);
      this.logger.debug(`MFA flow completed for email="${credentials.email}"`);
      await this.waitForAuthenticatedState(page);
      this.logger.debug(`Authenticated browser state reached for email="${credentials.email}" currentUrl="${page.url()}"`);

      const browserValidation = await this.validateBrowserSession(page, null);

      if (!browserValidation.valid) {
        throw new UnauthorizedException(browserValidation.reason);
      }

      const cookies = (await page.browserContext().cookies()).map((cookie) =>
        this.mapPuppeteerCookie(cookie),
      );
      this.logger.debug(
        `Captured ${cookies.length} browser cookie(s) for integration="${integration.integrationKey}"`,
      );

      if (!cookies.length) {
        throw new UnauthorizedException(
          'Airtable login completed without returning any session cookies.',
        );
      }

      const validation = await this.validateCookiesAgainstAirtable(cookies, null);

      if (!validation.valid) {
        throw new UnauthorizedException(validation.reason);
      }

      const updatedIntegration = await this.integrationsService.storeSessionCookies(integration, {
        cookies,
        expiresAt: validation.cookieExpiresAt ?? undefined,
      });
      this.logger.log(
        `Stored ${cookies.length} Airtable session cookie(s) for integration="${integration.integrationKey}" cookieExpiresAt=${validation.cookieExpiresAt?.toISOString() ?? 'null'}`,
      );

      return updatedIntegration;
    } catch (error) {
      this.logger.error(
        `Airtable session login flow failed for integration="${integration.integrationKey}" email="${credentials.email}"`,
        error instanceof Error ? error.stack : undefined,
      );
      throw this.normalizeSessionLoginError(error);
    } finally {
      await browser.close().catch(() => undefined);
    }
  }

  private async completeCredentialFlow(
    page: Page,
    credentials: SessionCredentials,
    slowMoMs: number,
    interactionTimeoutMs: number,
  ): Promise<void> {
    const emailSelectors = [
      'input[type="email"]',
      'input[name="email"]',
      'input[name="username"]',
      'input[autocomplete="username"]',
      'input[placeholder*="email" i]',
      'input[aria-label*="email" i]',
      'input[type="text"]',
    ];
    const passwordSelectors = [
      'input[type="password"]',
      'input[name="password"]',
      'input[autocomplete="current-password"]',
    ];
    const submitSelectors = [
      'button[type="submit"]',
      'input[type="submit"]',
      'button[data-testid*="submit"]',
      'button[data-test-id*="submit"]',
      '[role="button"]',
      'button',
    ];

    await this.waitForAnySelector(
      page,
      [...emailSelectors, ...passwordSelectors],
      interactionTimeoutMs,
    );

    const emailFilled = await this.fillFirstAvailable(
      page,
      emailSelectors,
      credentials.email,
      interactionTimeoutMs,
    );

    if (!emailFilled) {
      throw new ServiceUnavailableException(
        'Unable to find the Airtable email input on the login page.',
      );
    }

    await this.sleep(slowMoMs);

    await this.clickFirstAvailable(
      page,
      submitSelectors,
      ['continue', 'next', 'log in', 'login', 'sign in'],
      4_000,
    );
    await page
      .waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 6_000,
      })
      .catch(() => undefined);
    await this.sleep(slowMoMs);

    await this.waitForAnySelector(page, passwordSelectors, interactionTimeoutMs);

    const passwordFilled = await this.fillFirstAvailable(
      page,
      passwordSelectors,
      credentials.password,
      interactionTimeoutMs,
    );

    if (!passwordFilled) {
      throw new ServiceUnavailableException(
        'Unable to find the Airtable password input on the login page.',
      );
    }

    await this.sleep(slowMoMs);
    await this.clickFirstAvailable(
      page,
      submitSelectors,
      ['continue', 'next', 'log in', 'login', 'sign in'],
      4_000,
    );
    await page.waitForNavigation({
      waitUntil: 'networkidle2',
      timeout: this.getNavigationTimeoutMs(),
    }).catch(() => undefined);

    const passwordVisible = await this.hasAnySelector(page, passwordSelectors);

    if (passwordVisible) {
      await this.fillFirstAvailable(
        page,
        passwordSelectors,
        credentials.password,
        interactionTimeoutMs,
      );
      await this.sleep(slowMoMs);
      await this.clickFirstAvailable(
        page,
        submitSelectors,
        ['continue', 'next', 'log in', 'login', 'sign in'],
        4_000,
      );
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
    parsedChanges?: ParsedRevisionHistoryChange[];
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
        this.logger.debug(
          `Revision history fetch attempt ${attempt}/${maxAttempts} for recordId=${record.recordId}`,
        );
        const payload = await this.fetchRevisionHistoryApiPayload(
          activeIntegration.sessionCookies,
          record,
        );
        const parsedChanges = this.revisionParserService.parseRevisionHistoryApiPayload(
          payload as never,
          {
            sourceUrl: this.buildRowActivityUrl(record, null),
          },
        );
        this.logger.debug(
          `Revision history payload fetched for recordId=${record.recordId} parsedChanges=${parsedChanges.length}`,
        );

        return {
          html: '',
          sourceUrl: this.buildRowActivityUrl(record, null),
          integration: activeIntegration,
          refreshedCookies,
          parsedChanges,
        };
      } catch (error) {
        if (error instanceof SessionExpiredError && !refreshedCookies) {
          this.logger.warn(
            `Session expired during revision-history fetch for recordId=${record.recordId}; refreshing cookies and retrying.`,
          );
          activeIntegration = await this.loginAndCaptureCookies(
            activeIntegration,
            this.resolveSessionCredentials(dto),
            record,
          );
          refreshedCookies = true;
          continue;
        }

        if (attempt < maxAttempts && error instanceof RetryableRevisionHistoryError) {
          this.logger.warn(
            `Retryable revision-history error for recordId=${record.recordId} on attempt=${attempt}: ${error.message}`,
          );
          await this.sleep(this.getRetryDelayMs(attempt));
          continue;
        }

        if (
          error instanceof ServiceUnavailableException &&
          error.message.includes('row activity endpoint returned 404')
        ) {
          this.logger.warn(
            `Falling back to browser-based revision-history scrape for recordId=${record.recordId}`,
          );
          const html = await this.fetchRevisionHistoryFromBrowser(
            activeIntegration,
            record,
          );

          return {
            html,
            sourceUrl: this.buildRecordUiUrl(record),
            integration: activeIntegration,
            refreshedCookies,
          };
        }

        throw error;
      }
    }

    throw new ServiceUnavailableException(
      `Unable to fetch Airtable revision history for record ${record.recordId}.`,
    );
  }

  private async fetchRevisionHistoryApiPayload(
    cookies: BrowserCookie[],
    record: RecordTarget,
  ): Promise<Record<string, unknown>> {
    const aggregated: Record<string, unknown> = {
      orderedActivityAndCommentIds: [],
      commentsById: {},
      notificationLevel: undefined,
      userIdsWatchingComments: [],
      offset: null,
      offsetV2: null,
      isRevisionHistoryDisabled: false,
      rowActivityOrCommentUserObjById: {},
      rowActivityInfoById: {},
      signedUserContentUrls: {},
    };
    let offsetV2: string | null = null;

    do {
      const url = this.buildRowActivityUrl(record, offsetV2);
      this.logger.debug(`Requesting row activity url="${url}"`);
      const response = await fetch(url, {
        method: 'GET',
        headers: this.buildRowActivityHeaders(cookies, record),
        redirect: 'manual',
        signal: AbortSignal.timeout(this.getRequestTimeoutMs()),
      });
      const body = await response.text();
      const bodySnippet = body.slice(0, 240).replace(/\s+/g, ' ').trim();
      this.logger.debug(
        `Row activity response for recordId=${record.recordId} status=${response.status} bodyLength=${body.length} bodySnippet="${bodySnippet}"`,
      );

      if (
        this.responseLooksUnauthenticated(
          response.status,
          body,
          response.headers.get('location'),
        )
      ) {
        throw new SessionExpiredError(
          'Stored Airtable cookies are invalid for the row activity endpoint.',
        );
      }

      if (response.status === 404) {
        throw new ServiceUnavailableException(
          `Airtable row activity endpoint returned 404. Last response snippet: "${bodySnippet || 'n/a'}"`,
        );
      }

      if (response.status === 429 || response.status >= 500) {
        throw new RetryableRevisionHistoryError(
          `Airtable row activity endpoint returned ${response.status}.`,
        );
      }

      if (!response.ok) {
        throw new ServiceUnavailableException(
          `Airtable row activity endpoint returned ${response.status}.`,
        );
      }

      let payload: Record<string, unknown>;

      try {
        payload = JSON.parse(body) as Record<string, unknown>;
      } catch (error) {
        throw new ServiceUnavailableException(
          `Airtable row activity endpoint returned invalid JSON: ${error instanceof Error ? error.message : 'unknown parse failure'}`,
        );
      }

      const orderedIds =
        (payload.orderedActivityAndCommentIds as string[] | undefined) ?? [];
      (aggregated.orderedActivityAndCommentIds as string[]).push(...orderedIds);
      Object.assign(
        aggregated.rowActivityOrCommentUserObjById as Record<string, unknown>,
        (payload.rowActivityOrCommentUserObjById as Record<string, unknown> | undefined) ?? {},
      );
      Object.assign(
        aggregated.rowActivityInfoById as Record<string, unknown>,
        (payload.rowActivityInfoById as Record<string, unknown> | undefined) ?? {},
      );
      aggregated.notificationLevel = payload.notificationLevel;
      aggregated.isRevisionHistoryDisabled = payload.isRevisionHistoryDisabled ?? false;
      offsetV2 =
        typeof payload.offsetV2 === 'string' && payload.offsetV2.trim()
          ? payload.offsetV2
          : null;
      aggregated.offsetV2 = offsetV2;
    } while (offsetV2);

    return aggregated;
  }

  private async persistRevisionChanges(
    integration: IntegrationDocument,
    record: RecordTarget,
    changes: ParsedRevisionHistoryChange[],
    sourceUrl: string,
    tableNameCache?: Map<string, string | undefined>,
  ): Promise<number> {
    if (!changes.length) {
      this.logger.debug(`No matching revision-history changes to persist for recordId=${record.recordId}`);
      return 0;
    }

    const tableName = await this.resolveTableName(
      integration,
      record,
      tableNameCache,
    );

    const operations = changes.map((change) => {
      const dedupeKey = this.buildRevisionDedupeKey(record, change);
      const uuid = this.buildRevisionEntryUuid(record, change);
      const authoredBy =
        change.changedBy.userId?.trim() ||
        change.changedBy.email?.trim() ||
        change.changedBy.name?.trim() ||
        undefined;

      return {
        updateOne: {
          filter: {
            dedupeKey,
          },
          update: {
            $set: {
              integrationId: integration._id,
              baseId: record.baseId,
              tableId: record.tableId,
              tableName,
              recordId: record.recordId,
              activityId: change.activityId,
              uuid,
              issueId: record.recordId,
              changeType: change.changeType,
              columnType: change.columnType,
              fieldName: change.fieldName,
              columnId: change.columnId,
              groupType: change.groupType,
              oldValue: change.oldValue,
              newValue: change.newValue,
              changedAt: change.changedAt,
              createdDate: change.changedAt,
              changedBy: change.changedBy,
              authoredBy,
              dedupeKey,
              sourceUrl,
              syncedAt: new Date(),
              rawHtmlSnippet: change.rawHtmlSnippet,
            },
          },
          upsert: true,
        },
      };
    });

    await this.revisionHistoryModel.bulkWrite(operations as never, { ordered: false });
    this.logger.debug(
      `Bulk upsert completed for recordId=${record.recordId} operations=${operations.length}`,
    );

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

  private buildRevisionEntryUuid(
    record: RecordTarget,
    change: ParsedRevisionHistoryChange,
  ): string {
    return createHash('sha256')
      .update(
        JSON.stringify({
          activityId: change.activityId ?? null,
          baseId: record.baseId,
          tableId: record.tableId,
          recordId: record.recordId,
          columnId: change.columnId ?? null,
          fieldName: change.fieldName,
          columnType: change.columnType,
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
    return this.buildRowActivityUrl(record, null);
  }

  private buildRowActivityUrl(
    record: RecordTarget,
    offsetV2: string | null,
  ): string {
    const baseUrl =
      this.configService.get<string>('AIRTABLE_ROW_ACTIVITY_URL_BASE') ??
      'https://airtable.com/v0.3/row';
    const params = {
      limit: envNumber(
        this.configService.get<string>('AIRTABLE_REVISION_HISTORY_PAGE_SIZE'),
        50,
      ),
      offsetV2,
      shouldReturnDeserializedActivityItems: true,
      shouldIncludeRowActivityOrCommentUserObjById: true,
    };
    const url = new URL(
      `${baseUrl}/${encodeURIComponent(record.recordId)}/readRowActivitiesAndComments`,
    );
    url.searchParams.set('stringifiedObjectParams', JSON.stringify(params));
    url.searchParams.set('requestId', `req${randomBytes(8).toString('hex')}`);

    return url.toString();
  }

  private buildRowActivityHeaders(
    cookies: BrowserCookie[],
    record: RecordTarget,
  ): Record<string, string> {
    return {
      ...this.buildAirtableHttpHeaders(cookies, `${this.buildRecordUiUrl(record)}?blocks=hide`),
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'X-Requested-With': 'XMLHttpRequest',
      'X-Airtable-Application-Id': record.baseId,
      'X-Airtable-Inter-Service-Client': 'webClient',
      'X-User-Locale': this.configService.get<string>('SCRAPER_USER_LOCALE') ?? 'en',
      'X-Time-Zone': this.configService.get<string>('SCRAPER_TIME_ZONE') ?? 'Asia/Karachi',
    };
  }

  private async fetchRevisionHistoryFromBrowser(
    integration: IntegrationDocument,
    record: RecordTarget,
  ): Promise<string> {
    const launchTimeoutMs = this.getNavigationTimeoutMs();
    const executablePath = this.resolveBrowserExecutablePath();
    const candidateUrls = await this.buildRecordUiUrlCandidates(integration, record);
    let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

    this.logger.warn(
      `Hidden revision-history endpoint was not found. Using browser fallback for recordId=${record.recordId} candidateUrls=${JSON.stringify(candidateUrls)}`,
    );

    try {
      browser = await puppeteer.launch({
        headless: envBoolean(this.configService.get<string>('PUPPETEER_HEADLESS'), true),
        executablePath,
        timeout: launchTimeoutMs,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      });

      const page = await browser.newPage();
      page.setDefaultTimeout(this.getDefaultTimeoutMs());
      page.setDefaultNavigationTimeout(this.getNavigationTimeoutMs());
      await page.setViewport({ width: 1440, height: 1024 });
      await page.setUserAgent(this.getBrowserUserAgent());
      await this.applyCookiesToPage(page, integration.sessionCookies ?? []);

      for (const candidateUrl of candidateUrls) {
        this.logger.debug(
          `Browser fallback navigating to Airtable record UI url="${candidateUrl}" for recordId=${record.recordId}`,
        );
        await page.goto(candidateUrl, {
          waitUntil: 'networkidle2',
          timeout: this.getNavigationTimeoutMs(),
        }).catch(() => undefined);

        const currentUrl = page.url();
        const html = await page.content().catch(() => '');

        if (this.responseLooksUnauthenticated(200, html, currentUrl)) {
          throw new SessionExpiredError(
            'Stored Airtable cookies are invalid for the browser fallback scrape.',
          );
        }

        await this.tryOpenRevisionHistoryInBrowser(page);
        const expandedHtml = await page.content().catch(() => '');

        if (expandedHtml && /revision history|all activity|comments|status|assignee|assigned/i.test(expandedHtml)) {
          this.logger.debug(
            `Browser fallback captured page HTML for recordId=${record.recordId} url="${candidateUrl}" htmlLength=${expandedHtml.length}`,
          );
          return expandedHtml;
        }
      }

      throw new ServiceUnavailableException(
        `Browser fallback could not open Airtable record revision history for record ${record.recordId}.`,
      );
    } catch (error) {
      if (
        error instanceof SessionExpiredError ||
        error instanceof ServiceUnavailableException
      ) {
        throw error;
      }

      if (error instanceof Error) {
        throw new ServiceUnavailableException(
          `Browser fallback failed for record ${record.recordId}: ${error.message}`,
        );
      }

      throw new ServiceUnavailableException(
        `Browser fallback failed for record ${record.recordId}.`,
      );
    } finally {
      await browser?.close().catch(() => undefined);
    }
  }

  private async buildRecordUiUrlCandidates(
    integration: IntegrationDocument,
    record: RecordTarget,
  ): Promise<string[]> {
    const baseUiUrl =
      this.configService.get<string>('AIRTABLE_BASE_UI_URL') ?? 'https://airtable.com';
    const table = await this.airtableTableModel
      .findOne({
        integrationId: integration._id,
        baseId: record.baseId,
        tableId: record.tableId,
      })
      .select({ views: 1 })
      .lean()
      .exec();
    const preferredView =
      table?.views?.find((view) => !view.personalForViewer)?.id ??
      table?.views?.[0]?.id;
    const candidates = [
      `${baseUiUrl}/${record.baseId}/${record.tableId}/${record.recordId}`,
      preferredView
        ? `${baseUiUrl}/${record.baseId}/${record.tableId}/${preferredView}/${record.recordId}`
        : null,
      preferredView
        ? `${baseUiUrl}/${record.baseId}/${preferredView}/${record.recordId}`
        : null,
    ].filter((value): value is string => Boolean(value));

    return [...new Set(candidates)];
  }

  private async resolveTableName(
    integration: IntegrationDocument,
    record: RecordTarget,
    cache?: Map<string, string | undefined>,
  ): Promise<string | undefined> {
    const cacheKey = `${String(integration._id)}:${record.baseId}:${record.tableId}`;

    if (cache?.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    const table = await this.airtableTableModel
      .findOne({
        integrationId: integration._id,
        baseId: record.baseId,
        tableId: record.tableId,
      })
      .select({ name: 1 })
      .lean()
      .exec();
    const tableName = table?.name;

    cache?.set(cacheKey, tableName);

    return tableName;
  }

  private buildRecordUiUrl(record: RecordTarget): string {
    const baseUiUrl =
      this.configService.get<string>('AIRTABLE_BASE_UI_URL') ?? 'https://airtable.com';

    return `${baseUiUrl}/${record.baseId}/${record.tableId}/${record.recordId}`;
  }

  private async applyCookiesToPage(page: Page, cookies: BrowserCookie[]): Promise<void> {
    if (!cookies.length) {
      return;
    }

    await page.setCookie(
      ...cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain ?? '.airtable.com',
        path: cookie.path ?? '/',
        expires: cookie.expires,
        httpOnly: cookie.httpOnly,
        secure: cookie.secure,
        sameSite: this.mapCookieSameSite(cookie.sameSite),
      })),
    );
  }

  private mapCookieSameSite(
    sameSite: string | undefined,
  ): 'Strict' | 'Lax' | 'None' | undefined {
    if (!sameSite) {
      return undefined;
    }

    const normalized = sameSite.toLowerCase();

    if (normalized === 'strict') {
      return 'Strict';
    }

    if (normalized === 'none') {
      return 'None';
    }

    if (normalized === 'lax') {
      return 'Lax';
    }

    return undefined;
  }

  private async tryOpenRevisionHistoryInBrowser(page: Page): Promise<void> {
    const buttonLabels = [
      'see revision history',
      'revision history',
      'all activity',
      'comments',
    ];

    for (const label of buttonLabels) {
      const clicked = await this.clickButtonByText(page, [label]);

      if (clicked) {
        await page.waitForNetworkIdle({
          idleTime: 500,
          timeout: this.getNavigationTimeoutMs(),
        }).catch(() => undefined);
        await this.sleep(750);
      }
    }
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
    const loginFormPatterns = [
      /input[^>]+type=["']password["']/i,
      /autocomplete=["']username["']/i,
      /autocomplete=["']current-password["']/i,
      /two-factor/i,
      /one-time code/i,
    ];

    return (
      status === 401 ||
      status === 403 ||
      [302, 303, 307, 308].includes(status) ||
      Boolean(locationHeader && /login/i.test(locationHeader)) ||
      loginFormPatterns.some((pattern) => pattern.test(body))
    );
  }

  private buildAirtableHttpHeaders(
    cookies: BrowserCookie[],
    refererUrl?: string,
  ): Record<string, string> {
    return {
      Cookie: this.buildCookieHeader(cookies),
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent': this.getBrowserUserAgent(),
      Referer: refererUrl ?? this.getLoginUrl(),
      'Upgrade-Insecure-Requests': '1',
    };
  }

  private async validateBrowserSession(
    page: Page,
    probeRecord?: RecordTarget | null,
  ): Promise<CookieValidationResult> {
    const validationUrl = probeRecord
      ? this.buildRevisionHistoryUrl(probeRecord)
      : this.getCookieValidationUrl();
    const response = await page
      .goto(validationUrl, {
        waitUntil: 'networkidle2',
        timeout: this.getNavigationTimeoutMs(),
      })
      .catch(() => null);
    const body = await page.content().catch(() => '');
    const currentUrl = page.url();
    const status = response?.status() ?? 200;
    const valid =
      status < 400 &&
      !this.responseLooksUnauthenticated(status, body, currentUrl);

    return {
      valid,
      checkedAt: new Date().toISOString(),
      reason: valid
        ? 'Stored Airtable cookies are valid.'
        : 'Stored Airtable cookies are missing, expired, or redirected to login.',
      cookieExpiresAt: null,
      recordProbe: probeRecord ?? null,
    };
  }

  private async fillFirstAvailable(
    page: Page,
    selectors: string[],
    value: string,
    timeoutMs = 8_000,
  ): Promise<boolean> {
    for (const selector of selectors) {
      const input = await page
        .waitForSelector(selector, {
          timeout: timeoutMs,
          visible: true,
        })
        .catch(() => null);

      if (!input) {
        continue;
      }

      await input.click({ clickCount: 3 });
      await input.type(value, { delay: 20 });

      return true;
    }

    return false;
  }

  private async clickFirstAvailable(
    page: Page,
    selectors: string[],
    buttonTexts: string[] = [],
    timeoutMs = 4_000,
  ): Promise<boolean> {
    for (const selector of selectors) {
      const element = await page
        .waitForSelector(selector, {
          timeout: timeoutMs,
          visible: true,
        })
        .catch(() => null);

      if (!element) {
        continue;
      }

      await element.click();

      return true;
    }

    if (buttonTexts.length) {
      const clickedByText = await this.clickButtonByText(page, buttonTexts);

      if (clickedByText) {
        return true;
      }
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

  private async waitForAnySelector(
    page: Page,
    selectors: string[],
    timeoutMs: number,
  ): Promise<void> {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (await this.hasAnySelector(page, selectors)) {
        return;
      }

      await this.sleep(250);
    }

    throw new ServiceUnavailableException(
      `Unable to find the expected Airtable login controls within ${timeoutMs}ms.`,
    );
  }

  private async clickButtonByText(page: Page, buttonTexts: string[]): Promise<boolean> {
    const normalizedTargets = buttonTexts.map((entry) => entry.trim().toLowerCase());

    return page.evaluate((targets) => {
      const candidates = Array.from(
        document.querySelectorAll('button, [role="button"], input[type="submit"]'),
      ) as Array<HTMLElement | HTMLInputElement>;

      for (const candidate of candidates) {
        const label =
          'value' in candidate && typeof candidate.value === 'string'
            ? candidate.value
            : candidate.textContent ?? '';
        const normalizedLabel = label.trim().toLowerCase();

        if (normalizedLabel && targets.some((target) => normalizedLabel.includes(target))) {
          candidate.click();
          return true;
        }
      }

      return false;
    }, normalizedTargets);
  }

  private getLoginUrl(): string {
    return this.configService.get<string>('AIRTABLE_LOGIN_URL') ?? 'https://airtable.com/login';
  }

  private resolveBrowserExecutablePath(): string | undefined {
    const configuredPath = this.configService.get<string>('PUPPETEER_EXECUTABLE_PATH')?.trim();

    if (configuredPath) {
      return configuredPath;
    }

    const commonPaths = [
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/brave-browser',
    ];

    return commonPaths.find((candidatePath) => existsSync(candidatePath));
  }

  private describeBrowserLaunchFailure(
    error: unknown,
    executablePath?: string,
  ): string {
    const baseMessage = executablePath
      ? `Puppeteer could not launch the browser at ${executablePath}.`
      : 'Puppeteer could not find a usable browser executable.';

    const details =
      error instanceof Error && error.message ? ` ${error.message}` : '';

    return `${baseMessage}${details} Set PUPPETEER_EXECUTABLE_PATH if needed.`;
  }

  private normalizeSessionLoginError(error: unknown): Error {
    if (
      error instanceof BadRequestException ||
      error instanceof UnauthorizedException ||
      error instanceof ServiceUnavailableException ||
      error instanceof NotFoundException
    ) {
      return error;
    }

    if (error instanceof Error) {
      return new ServiceUnavailableException(
        `Airtable session login failed: ${error.message}`,
      );
    }

    return new ServiceUnavailableException('Airtable session login failed.');
  }

  private getCookieValidationUrl(): string {
    return this.configService.get<string>('AIRTABLE_COOKIE_VALIDATION_URL') ?? 'https://airtable.com/home';
  }

  private getBrowserUserAgent(): string {
    return (
      this.configService.get<string>('SCRAPER_USER_AGENT') ??
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    );
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
      errorHistory: [],
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
    await this.scrapeJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          recordsProcessed,
          lastHeartbeatAt: job.lastHeartbeatAt,
        },
      },
    );
  }

  private async appendJobError(
    job: ScrapeJobDocument,
    error: unknown,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unexpected scraper error.';

    job.lastError = message;
    job.lastHeartbeatAt = new Date();
    const errorHistory = job.errorHistory ?? [];
    errorHistory.push({
      message,
      at: new Date(),
      details,
    });
    job.errorHistory = errorHistory;
    const latestError = errorHistory[errorHistory.length - 1];

    await this.scrapeJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          lastError: message,
          lastHeartbeatAt: job.lastHeartbeatAt,
        },
        $push: {
          errorHistory: latestError,
        },
      },
    );
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
    await this.scrapeJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: job.status,
          finishedAt: job.finishedAt,
          lastHeartbeatAt: job.lastHeartbeatAt,
          metadata: job.metadata,
        },
      },
    );
  }

  private async failJob(job: ScrapeJobDocument, error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : 'Unexpected scraper failure.';

    job.status = 'failed';
    job.finishedAt = new Date();
    job.lastHeartbeatAt = new Date();
    job.lastError = message;
    const errorHistory = job.errorHistory ?? [];
    errorHistory.push({
      message,
      at: new Date(),
      details: {},
    });
    job.errorHistory = errorHistory;
    const latestError = errorHistory[errorHistory.length - 1];

    await this.scrapeJobModel.updateOne(
      { _id: job._id },
      {
        $set: {
          status: job.status,
          finishedAt: job.finishedAt,
          lastHeartbeatAt: job.lastHeartbeatAt,
          lastError: job.lastError,
        },
        $push: {
          errorHistory: latestError,
        },
      },
    );
  }

  private async safeUpdateJobProgress(
    job: ScrapeJobDocument,
    recordsProcessed: number,
  ): Promise<void> {
    await this.swallowJobMutationErrors(() =>
      this.updateJobProgress(job, recordsProcessed),
    );
  }

  private async safeAppendJobError(
    job: ScrapeJobDocument,
    error: unknown,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    await this.swallowJobMutationErrors(() =>
      this.appendJobError(job, error, details),
    );
  }

  private async safeCompleteJob(
    job: ScrapeJobDocument,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.swallowJobMutationErrors(() => this.completeJob(job, metadata));
  }

  private async safeFailJob(job: ScrapeJobDocument, error: unknown): Promise<void> {
    await this.swallowJobMutationErrors(() => this.failJob(job, error));
  }

  private async swallowJobMutationErrors(
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch {
      // Job telemetry should never mask the original scraper failure.
    }
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
