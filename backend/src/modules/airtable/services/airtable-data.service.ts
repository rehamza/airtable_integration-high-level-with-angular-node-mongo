import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { IntegrationsService } from '../../integrations/services/integrations.service';
import {
  AirtableBase,
  AirtableBaseDocument,
} from '../schemas/airtable-base.schema';
import {
  AirtableTable,
  AirtableTableDocument,
} from '../schemas/airtable-table.schema';
import {
  AirtablePage,
  AirtablePageDocument,
} from '../schemas/airtable-page.schema';
import {
  AirtableUser,
  AirtableUserDocument,
} from '../schemas/airtable-user.schema';
import {
  AirtableRevisionHistory,
  AirtableRevisionHistoryDocument,
} from '../schemas/airtable-revision-history.schema';
import { ScrapeJob, ScrapeJobDocument } from '../schemas/scrape-job.schema';
import { AirtableCollectionQueryDto } from '../dto/airtable-collection-query.dto';
import { AirtableScrapeJobQueryDto } from '../dto/airtable-scrape-job-query.dto';

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

@Injectable()
export class AirtableDataService {
  constructor(
    private readonly integrationsService: IntegrationsService,
    @InjectModel(AirtableBase.name)
    private readonly airtableBaseModel: Model<AirtableBaseDocument>,
    @InjectModel(AirtableTable.name)
    private readonly airtableTableModel: Model<AirtableTableDocument>,
    @InjectModel(AirtablePage.name)
    private readonly airtablePageModel: Model<AirtablePageDocument>,
    @InjectModel(AirtableUser.name)
    private readonly airtableUserModel: Model<AirtableUserDocument>,
    @InjectModel(AirtableRevisionHistory.name)
    private readonly airtableRevisionHistoryModel: Model<AirtableRevisionHistoryDocument>,
    @InjectModel(ScrapeJob.name)
    private readonly scrapeJobModel: Model<ScrapeJobDocument>,
  ) {}

  getEndpointCatalog() {
    return {
      basePath: '/api/integrations/airtable',
      oauthFlow: [
        {
          step: 1,
          method: 'GET',
          path: '/api/integrations/airtable/authorize?integrationKey=default',
          purpose: 'Redirect the browser to Airtable OAuth with PKCE.',
        },
        {
          step: 2,
          method: 'GET',
          path: '/api/integrations/airtable/callback',
          purpose: 'Receive the Airtable callback and exchange the code for tokens.',
        },
        {
          step: 3,
          method: 'GET',
          path: '/api/integrations/airtable/status?integrationKey=default',
          purpose: 'Inspect the stored connection state and token freshness.',
        },
        {
          step: 4,
          method: 'POST',
          path: '/api/integrations/airtable/refresh',
          purpose: 'Force a token refresh using the stored refresh token.',
        },
      ],
      syncAndScrape: [
        {
          method: 'POST',
          path: '/api/integrations/airtable/sync',
          purpose: 'Fetch bases, tables, pages, and inferred users into MongoDB.',
        },
        {
          method: 'POST',
          path: '/api/integrations/airtable/session/login',
          purpose: 'Launch Puppeteer, log in to Airtable, handle MFA, and store cookies.',
        },
        {
          method: 'POST',
          path: '/api/integrations/airtable/session/validate',
          purpose: 'Check whether the stored Airtable cookies are still valid.',
        },
        {
          method: 'POST',
          path: '/api/integrations/airtable/revision-history/sync',
          purpose: 'Scrape revision history for pages and store only status/assignee changes.',
        },
      ],
      readEndpoints: [
        'GET /api/integrations/airtable/bases',
        'GET /api/integrations/airtable/tables',
        'GET /api/integrations/airtable/pages',
        'GET /api/integrations/airtable/users',
        'GET /api/integrations/airtable/revision-history',
        'GET /api/integrations/airtable/scrape-jobs',
        'GET /api/integrations/airtable/scrape-jobs/:jobId',
        'GET /api/grid/options',
        'GET /api/grid/data',
      ],
    };
  }

  async listBases(
    query: AirtableCollectionQueryDto = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const integration = await this.requireIntegration(query.integrationKey);
    const filter: Record<string, unknown> = {
      integrationId: integration._id,
    };

    if (query.baseId) {
      filter.baseId = query.baseId;
    }

    const mongoFilter = this.withSearch(filter, query.search, [
      'baseId',
      'name',
      'workspaceId',
      'workspaceName',
      'permissionLevel',
    ]);

    return this.findPaginated(this.airtableBaseModel, mongoFilter, {
      page: query.page,
      pageSize: query.pageSize,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      defaultSortField: 'name',
    });
  }

  async listTables(
    query: AirtableCollectionQueryDto = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const integration = await this.requireIntegration(query.integrationKey);
    const filter: Record<string, unknown> = {
      integrationId: integration._id,
    };

    if (query.baseId) {
      filter.baseId = query.baseId;
    }

    if (query.tableId) {
      filter.tableId = query.tableId;
    }

    const mongoFilter = this.withSearch(filter, query.search, [
      'baseId',
      'tableId',
      'name',
      'description',
      'primaryFieldId',
    ]);

    return this.findPaginated(this.airtableTableModel, mongoFilter, {
      page: query.page,
      pageSize: query.pageSize,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      defaultSortField: 'name',
    });
  }

  async listPages(
    query: AirtableCollectionQueryDto = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const integration = await this.requireIntegration(query.integrationKey);
    const filter: Record<string, unknown> = {
      integrationId: integration._id,
    };

    if (query.baseId) {
      filter.baseId = query.baseId;
    }

    if (query.tableId) {
      filter.tableId = query.tableId;
    }

    if (query.recordId) {
      filter.recordId = query.recordId;
    }

    const mongoFilter = this.withSearch(filter, query.search, [
      'recordId',
      'tableName',
    ], ['fields']);

    return this.findPaginated(this.airtablePageModel, mongoFilter, {
      page: query.page,
      pageSize: query.pageSize,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      defaultSortField: 'createdTime',
    });
  }

  async listUsers(
    query: AirtableCollectionQueryDto = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const integration = await this.requireIntegration(query.integrationKey);
    const filter: Record<string, unknown> = {
      integrationId: integration._id,
    };

    if (query.recordId) {
      filter.airtableUserId = query.recordId;
    }

    const mongoFilter = this.withSearch(filter, query.search, [
      'airtableUserId',
      'email',
      'name',
      'firstName',
      'lastName',
      'role',
      'locale',
      'timezone',
    ]);

    return this.findPaginated(this.airtableUserModel, mongoFilter, {
      page: query.page,
      pageSize: query.pageSize,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder,
      defaultSortField: 'name',
    });
  }

  async listRevisionHistory(
    query: AirtableCollectionQueryDto = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const integration = await this.requireIntegration(query.integrationKey);
    const filter: Record<string, unknown> = {
      integrationId: integration._id,
    };

    if (query.baseId) {
      filter.baseId = query.baseId;
    }

    if (query.tableId) {
      filter.tableId = query.tableId;
    }

    if (query.recordId) {
      filter.recordId = query.recordId;
    }

    if (query.changeType) {
      filter.changeType = query.changeType;
    }

    const mongoFilter = this.withSearch(
      filter,
      query.search,
      ['recordId', 'fieldName', 'changeType', 'changedBy.name', 'changedBy.email'],
      ['oldValue', 'newValue'],
    );

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 100;
    const skip = (page - 1) * pageSize;
    const [rowsResult, total] = await Promise.all([
      this.airtableRevisionHistoryModel
        .find(mongoFilter)
        .sort(this.buildSort(query.sortBy, query.sortOrder, 'changedAt'))
        .skip(skip)
        .limit(pageSize)
        .lean()
        .exec(),
      this.airtableRevisionHistoryModel.countDocuments(mongoFilter).exec(),
    ]);
    const rows = await this.enrichRevisionHistoryRows(
      rowsResult as unknown as Array<Record<string, unknown>>,
      String(integration._id),
    );

    return {
      data: rows.map((row) => this.serialize(row)),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
    };
  }

  async listScrapeJobs(
    query: AirtableScrapeJobQueryDto = {},
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const integration = await this.requireIntegration(query.integrationKey);
    const filter: Record<string, unknown> = {
      integrationId: integration._id,
    };

    if (query.jobType) {
      filter.jobType = query.jobType;
    }

    if (query.status) {
      filter.status = query.status;
    }

    if (query.baseId) {
      filter.baseId = query.baseId;
    }

    if (query.tableId) {
      filter.tableId = query.tableId;
    }

    if (query.recordId) {
      filter.recordId = query.recordId;
    }

    const mongoFilter = this.withSearch(
      filter,
      query.search,
      ['jobType', 'status', 'targetEntity', 'targetId', 'lastError'],
      ['metadata'],
    );

    return this.findPaginated(this.scrapeJobModel, mongoFilter, {
      page: query.page,
      pageSize: query.pageSize,
      defaultSortField: 'queuedAt',
    });
  }

  async getScrapeJob(jobId: string, integrationKey?: string) {
    if (!Types.ObjectId.isValid(jobId)) {
      throw new NotFoundException(`Scrape job "${jobId}" was not found.`);
    }

    const integration = await this.requireIntegration(integrationKey);
    const job = await this.scrapeJobModel
      .findOne({
        _id: new Types.ObjectId(jobId),
        integrationId: integration._id,
      })
      .lean()
      .exec();

    if (!job) {
      throw new NotFoundException(`Scrape job "${jobId}" was not found.`);
    }

    return this.serialize(job);
  }

  private async requireIntegration(integrationKey = 'default') {
    return this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      integrationKey,
    );
  }

  private async findPaginated<TDocument>(
    model: Model<TDocument>,
    filter: Record<string, unknown>,
    options: {
      page?: number;
      pageSize?: number;
      sortBy?: string;
      sortOrder?: 'asc' | 'desc';
      defaultSortField: string;
    },
  ): Promise<PaginatedResponse<Record<string, unknown>>> {
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 100;
    const skip = (page - 1) * pageSize;
    const [rows, total] = await Promise.all([
      model
        .find(filter)
        .sort(this.buildSort(options.sortBy, options.sortOrder, options.defaultSortField))
        .skip(skip)
        .limit(pageSize)
        .lean()
        .exec(),
      model.countDocuments(filter).exec(),
    ]);

    return {
      data: rows.map((row) => this.serialize(row)),
      meta: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
    };
  }

  private withSearch<TDocument>(
    filter: Record<string, unknown>,
    search: string | undefined,
    directFields: string[],
    stringifiedFields: string[] = [],
  ): Record<string, unknown> {
    const value = search?.trim();

    if (!value) {
      return filter;
    }

    const pattern = this.escapeRegex(value);
    const regex = new RegExp(pattern, 'i');
    const orConditions: Array<Record<string, unknown>> = [
      ...directFields.map((field) => ({
        [field]: regex,
      })),
      ...stringifiedFields.map((field) => this.createStringifiedSearchExpression(field, pattern)),
    ];

    if (!orConditions.length) {
      return filter;
    }

    return {
      ...filter,
      $and: [
        {
          $or: orConditions,
        },
      ],
    };
  }

  private async enrichRevisionHistoryRows(
    rows: Array<Record<string, unknown>>,
    integrationId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const tableIds = [...new Set(
      rows
        .map((row) => (typeof row.tableId === 'string' ? row.tableId : undefined))
        .filter((value): value is string => Boolean(value)),
    )];

    if (!tableIds.length) {
      return rows;
    }

    const tables = await this.airtableTableModel
      .find({
        integrationId,
        tableId: { $in: tableIds },
      })
      .select({ tableId: 1, name: 1 })
      .lean()
      .exec();
    const tableNameById = new Map(
      tables.map((table) => [table.tableId, table.name]),
    );

    return rows.map((row) => ({
      ...row,
      tableName:
        typeof row.tableName === 'string' && row.tableName.trim()
          ? row.tableName
          : tableNameById.get(String(row.tableId)) ?? row.tableName,
    }));
  }

  private createStringifiedSearchExpression(field: string, pattern: string) {
    return {
      $expr: {
        $regexMatch: {
          input: {
            $toString: {
              $ifNull: [`$${field}`, ''],
            },
          },
          regex: pattern,
          options: 'i',
        },
      },
    };
  }

  private buildSort(
    sortBy: string | undefined,
    sortOrder: 'asc' | 'desc' | undefined,
    defaultSortField: string,
  ): Record<string, 1 | -1> {
    return {
      [sortBy?.trim() || defaultSortField]: sortOrder === 'asc' ? 1 : -1,
    };
  }

  private serialize(value: unknown): Record<string, unknown> {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
