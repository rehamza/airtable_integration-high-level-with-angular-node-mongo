import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { AirtableSyncService } from './airtable-sync.service';
import {
  AirtableApiService,
  AirtableBasePayload,
  AirtableRecordPayload,
  AirtableTablePayload,
} from './airtable-api.service';
import { IntegrationsService } from '../../integrations/services/integrations.service';
import { AirtableBaseDocument } from '../schemas/airtable-base.schema';
import { AirtableTableDocument } from '../schemas/airtable-table.schema';
import { AirtablePageDocument } from '../schemas/airtable-page.schema';
import { AirtableUserDocument } from '../schemas/airtable-user.schema';
import { IntegrationDocument } from '../../integrations/schemas/integration.schema';

describe('AirtableSyncService', () => {
  let service: AirtableSyncService;
  let configService: jest.Mocked<Pick<ConfigService, 'get'>>;
  let airtableApiService: jest.Mocked<
    Pick<AirtableApiService, 'listBases' | 'getBaseTables' | 'listAllRecords'>
  >;
  let integrationsService: jest.Mocked<
    Pick<
      IntegrationsService,
      | 'requireOneByProviderAndKey'
      | 'markSyncStarted'
      | 'markSyncCompleted'
      | 'markSyncFailed'
    >
  >;
  let airtableBaseModel: jest.Mocked<Pick<Model<AirtableBaseDocument>, 'bulkWrite'>>;
  let airtableTableModel: jest.Mocked<Pick<Model<AirtableTableDocument>, 'bulkWrite'>>;
  let airtablePageModel: jest.Mocked<Pick<Model<AirtablePageDocument>, 'bulkWrite'>>;
  let airtableUserModel: jest.Mocked<Pick<Model<AirtableUserDocument>, 'bulkWrite'>>;

  const integration = {
    _id: 'integration-1',
    integrationKey: 'default',
  } as unknown as IntegrationDocument;

  beforeEach(() => {
    configService = {
      get: jest.fn((key: string) => (key === 'AIRTABLE_SYNC_BATCH_SIZE' ? '2' : undefined)),
    };

    airtableApiService = {
      listBases: jest.fn(),
      getBaseTables: jest.fn(),
      listAllRecords: jest.fn(),
    };

    integrationsService = {
      requireOneByProviderAndKey: jest.fn().mockResolvedValue(integration),
      markSyncStarted: jest.fn().mockResolvedValue(integration),
      markSyncCompleted: jest.fn().mockImplementation(async (_doc, summary) => ({
        ...integration,
        lastSyncStatus: 'success',
        lastSyncedAt: new Date('2026-04-08T10:00:00.000Z'),
        metadata: {
          lastSyncSummary: summary,
        },
      })),
      markSyncFailed: jest.fn().mockResolvedValue(integration),
    };

    airtableBaseModel = {
      bulkWrite: jest.fn().mockResolvedValue(undefined),
    };
    airtableTableModel = {
      bulkWrite: jest.fn().mockResolvedValue(undefined),
    };
    airtablePageModel = {
      bulkWrite: jest.fn().mockResolvedValue(undefined),
    };
    airtableUserModel = {
      bulkWrite: jest.fn().mockResolvedValue(undefined),
    };

    service = new AirtableSyncService(
      configService as ConfigService,
      airtableApiService as AirtableApiService,
      integrationsService as IntegrationsService,
      airtableBaseModel as unknown as Model<AirtableBaseDocument>,
      airtableTableModel as unknown as Model<AirtableTableDocument>,
      airtablePageModel as unknown as Model<AirtablePageDocument>,
      airtableUserModel as unknown as Model<AirtableUserDocument>,
    );
  });

  it('syncs bases, tables, records, and discovered users with chunked bulk upserts', async () => {
    const bases: AirtableBasePayload[] = [
      {
        id: 'baseA',
        name: 'Alpha Base',
        permissionLevel: 'create',
      },
    ];
    const tables: AirtableTablePayload[] = [
      {
        id: 'tblA',
        name: 'Tasks',
        primaryFieldId: 'fldPrimary',
        fields: [{ id: 'fldPrimary', name: 'Title', type: 'singleLineText' }],
      },
    ];
    const records: AirtableRecordPayload[] = [
      {
        id: 'rec1',
        createdTime: '2026-04-08T09:00:00.000Z',
        fields: {
          Title: 'First task',
          Assignee: { id: 'usrAlice', email: 'alice@example.com', name: 'Alice' },
        },
      },
      {
        id: 'rec2',
        createdTime: '2026-04-08T09:05:00.000Z',
        fields: {
          Title: 'Second task',
          Reviewers: [{ id: 'usrBob', email: 'bob@example.com', name: 'Bob' }],
        },
      },
      {
        id: 'rec3',
        createdTime: '2026-04-08T09:10:00.000Z',
        fields: {
          Title: 'Third task',
          Assignee: { id: 'usrAlice', email: 'alice@example.com', name: 'Alice' },
        },
      },
    ];

    airtableApiService.listBases.mockResolvedValue(bases);
    airtableApiService.getBaseTables.mockResolvedValue(tables);
    airtableApiService.listAllRecords.mockResolvedValue(records);

    const result = await service.runFullSync({
      integrationKey: 'default',
      includeRecords: true,
      includeUsers: true,
    });

    expect(airtableApiService.listBases).toHaveBeenCalledWith('default');
    expect(airtableApiService.getBaseTables).toHaveBeenCalledWith('baseA', 'default');
    expect(airtableApiService.listAllRecords).toHaveBeenCalledWith(
      'baseA',
      'tblA',
      'default',
    );
    expect(airtableBaseModel.bulkWrite).toHaveBeenCalledTimes(1);
    expect(airtableTableModel.bulkWrite).toHaveBeenCalledTimes(1);
    expect(airtablePageModel.bulkWrite).toHaveBeenCalledTimes(2);
    expect(airtableUserModel.bulkWrite).toHaveBeenCalledTimes(1);
    expect(integrationsService.markSyncCompleted).toHaveBeenCalledWith(
      integration,
      expect.objectContaining({
        basesSynced: 1,
        tablesSynced: 1,
        recordsSynced: 3,
        usersSynced: 2,
        syncedBaseIds: ['baseA'],
        syncedTableIds: ['tblA'],
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'success',
        basesSynced: 1,
        tablesSynced: 1,
        recordsSynced: 3,
        usersSynced: 2,
      }),
    );
  });

  it('marks the sync as failed when Airtable fetches throw', async () => {
    airtableApiService.listBases.mockRejectedValue(new Error('Airtable unavailable'));

    await expect(service.runFullSync({ integrationKey: 'default' })).rejects.toThrow(
      'Airtable unavailable',
    );

    expect(integrationsService.markSyncStarted).toHaveBeenCalledWith(integration);
    expect(integrationsService.markSyncFailed).toHaveBeenCalledWith(
      integration,
      'Airtable unavailable',
    );
    expect(integrationsService.markSyncCompleted).not.toHaveBeenCalled();
  });
});
