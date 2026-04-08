import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { AirtableScraperService } from './airtable-scraper.service';
import { IntegrationsService } from '../../integrations/services/integrations.service';
import { AirtableRevisionParserService } from './airtable-revision-parser.service';
import { AirtablePageDocument } from '../schemas/airtable-page.schema';
import { AirtableRevisionHistoryDocument } from '../schemas/airtable-revision-history.schema';
import { ScrapeJobDocument } from '../schemas/scrape-job.schema';
import { IntegrationDocument } from '../../integrations/schemas/integration.schema';

describe('AirtableScraperService', () => {
  let service: AirtableScraperService;
  let integrationsService: jest.Mocked<
    Pick<IntegrationsService, 'requireOneByProviderAndKey'>
  >;
  let pageModel: {
    find: jest.Mock;
  };
  let parserService: jest.Mocked<Pick<AirtableRevisionParserService, 'parseRevisionHistory'>>;

  const integration = {
    _id: 'integration-1',
    integrationKey: 'default',
    sessionCookies: [{ name: 'session', value: 'cookie' }],
  } as unknown as IntegrationDocument;

  beforeEach(() => {
    integrationsService = {
      requireOneByProviderAndKey: jest.fn().mockResolvedValue(integration),
    };

    const pageQuery = {
      sort: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([
        { baseId: 'app1', tableId: 'tbl1', recordId: 'rec1' },
        { baseId: 'app1', tableId: 'tbl1', recordId: 'rec2' },
      ]),
    };

    pageModel = {
      find: jest.fn().mockReturnValue(pageQuery),
    };

    parserService = {
      parseRevisionHistory: jest.fn().mockReturnValue([
        {
          changeType: 'status',
          fieldName: 'Status',
          oldValue: 'Todo',
          newValue: 'Done',
          changedAt: new Date('2026-04-08T09:00:00.000Z'),
          changedBy: {
            name: 'Sarah QA',
          },
          rawHtmlSnippet: '<article>status</article>',
        },
      ]),
    };

    service = new AirtableScraperService(
      {
        get: jest.fn((key: string) => {
          if (key === 'AIRTABLE_DEFAULT_INTEGRATION_KEY') {
            return 'default';
          }

          if (key === 'AIRTABLE_REVISION_HISTORY_PAGE_LIMIT') {
            return '200';
          }

          if (key === 'SCRAPER_CONCURRENCY') {
            return '2';
          }

          if (key === 'AIRTABLE_REVISION_HISTORY_MAX_ATTEMPTS') {
            return '2';
          }

          return undefined;
        }),
      } as ConfigService,
      integrationsService as IntegrationsService,
      parserService as AirtableRevisionParserService,
      pageModel as unknown as Model<AirtablePageDocument>,
      {
        bulkWrite: jest.fn().mockResolvedValue(undefined),
      } as unknown as Model<AirtableRevisionHistoryDocument>,
      {} as unknown as Model<ScrapeJobDocument>,
    );
  });

  it('scrapes stored pages and aggregates revision-history counts', async () => {
    const job = {
      _id: 'job-1',
      recordsProcessed: 0,
      errorHistory: [],
      metadata: {},
      save: jest.fn().mockResolvedValue(undefined),
    } as unknown as ScrapeJobDocument;

    jest
      .spyOn(service as never, 'createJob')
      .mockResolvedValue(job);
    jest
      .spyOn(service as never, 'ensureSessionCookies')
      .mockResolvedValue(integration);
    jest
      .spyOn(service as never, 'fetchRevisionHistoryWithRetry')
      .mockImplementation(async (_integration, record) => ({
        html: `<article>${record.recordId}</article>`,
        sourceUrl: `https://airtable.example/${record.recordId}`,
        integration,
        refreshedCookies: false,
      }));
    jest
      .spyOn(service as never, 'persistRevisionChanges')
      .mockResolvedValue(1);
    jest
      .spyOn(service as never, 'completeJob')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as never, 'updateJobProgress')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as never, 'appendJobError')
      .mockResolvedValue(undefined);

    const result = await service.scrapeRevisionHistory({
      integrationKey: 'default',
      limit: 200,
    });

    expect(integrationsService.requireOneByProviderAndKey).toHaveBeenCalledWith(
      'airtable',
      'default',
    );
    expect(pageModel.find).toHaveBeenCalled();
    expect(parserService.parseRevisionHistory).toHaveBeenCalledTimes(2);
    expect(result).toEqual(
      expect.objectContaining({
        status: 'completed',
        recordsProcessed: 2,
        recordsTotal: 2,
        revisionsStored: 2,
        statusChangesStored: 2,
        assigneeChangesStored: 0,
      }),
    );
  });
});
