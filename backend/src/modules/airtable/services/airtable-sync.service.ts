import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import { Model } from 'mongoose';
import { envNumber } from '../../../config/env.utils';
import {
  AirtableApiService,
  AirtableBasePayload,
  AirtableRecordPayload,
  AirtableTablePayload,
} from './airtable-api.service';
import { AirtableSyncDto } from '../dto/airtable-sync.dto';
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
import { IntegrationDocument } from '../../integrations/schemas/integration.schema';
import { IntegrationsService } from '../../integrations/services/integrations.service';

interface SyncSummary extends Record<string, unknown> {
  provider: 'airtable';
  integrationKey: string;
  startedAt: string;
  finishedAt: string;
  basesSynced: number;
  tablesSynced: number;
  recordsSynced: number;
  usersSynced: number;
  syncedBaseIds: string[];
  syncedTableIds: string[];
}

interface NormalizedUser {
  airtableUserId: string;
  email?: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  role?: string;
  locale?: string;
  timezone?: string;
  raw: Record<string, unknown>;
}

@Injectable()
export class AirtableSyncService {
  constructor(
    private readonly configService: ConfigService,
    private readonly airtableApiService: AirtableApiService,
    private readonly integrationsService: IntegrationsService,
    @InjectModel(AirtableBase.name)
    private readonly airtableBaseModel: Model<AirtableBaseDocument>,
    @InjectModel(AirtableTable.name)
    private readonly airtableTableModel: Model<AirtableTableDocument>,
    @InjectModel(AirtablePage.name)
    private readonly airtablePageModel: Model<AirtablePageDocument>,
    @InjectModel(AirtableUser.name)
    private readonly airtableUserModel: Model<AirtableUserDocument>,
  ) {}

  async runFullSync(dto: AirtableSyncDto = {}) {
    const integrationKey = dto.integrationKey;
    const includeRecords = dto.includeRecords ?? true;
    const includeUsers = dto.includeUsers ?? true;
    const startedAt = new Date();
    const discoveredUsers = new Map<string, NormalizedUser>();
    const syncedBaseIds: string[] = [];
    const syncedTableIds: string[] = [];
    let integration: IntegrationDocument | null = null;
    let totalTables = 0;
    let totalRecords = 0;

    try {
      integration = await this.integrationsService.requireOneByProviderAndKey(
        'airtable',
        dto.integrationKey ?? 'default',
      );
      await this.integrationsService.markSyncStarted(integration);

      const bases = await this.airtableApiService.listBases(integrationKey);

      if (bases.length) {
        await this.upsertBases(integration, bases);
      }

      for (const base of bases) {
        syncedBaseIds.push(base.id);
        this.collectUsersFromUnknown(base, discoveredUsers);

        const tables = await this.airtableApiService.getBaseTables(base.id, integrationKey);

        totalTables += tables.length;

        if (tables.length) {
          await this.upsertTables(integration, base.id, tables);
        }

        for (const table of tables) {
          syncedTableIds.push(table.id);
          this.collectUsersFromUnknown(table, discoveredUsers);

          if (!includeRecords) {
            continue;
          }

          const records = await this.airtableApiService.listAllRecords(
            base.id,
            table.id,
            integrationKey,
          );

          totalRecords += records.length;

          if (records.length) {
            await this.upsertRecords(integration, base, table, records);
          }

          if (includeUsers) {
            for (const record of records) {
              this.collectUsersFromUnknown(record.fields ?? {}, discoveredUsers);
            }
          }
        }
      }

      if (includeUsers && discoveredUsers.size) {
        await this.upsertUsers(integration, [...discoveredUsers.values()]);
      }

      const summary: SyncSummary = {
        provider: 'airtable',
        integrationKey: integration.integrationKey,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        basesSynced: bases.length,
        tablesSynced: totalTables,
        recordsSynced: totalRecords,
        usersSynced: includeUsers ? discoveredUsers.size : 0,
        syncedBaseIds,
        syncedTableIds,
      };

      const refreshedIntegration = await this.integrationsService.markSyncCompleted(
        integration,
        summary,
      );

      return {
        ...summary,
        status: refreshedIntegration.lastSyncStatus,
        lastSyncedAt: refreshedIntegration.lastSyncedAt,
      };
    } catch (error) {
      if (integration) {
        await this.integrationsService.markSyncFailed(
          integration,
          error instanceof Error ? error.message : 'Airtable sync failed.',
        );
      }

      throw error;
    }
  }

  private async upsertBases(
    integration: IntegrationDocument,
    bases: AirtableBasePayload[],
  ): Promise<void> {
    const operations = bases.map((base) =>
      this.buildUpsertOperation(
        {
          integrationId: integration._id,
          baseId: base.id,
        },
        {
          integrationId: integration._id,
          baseId: base.id,
          name: base.name,
          permissionLevel:
            typeof base.permissionLevel === 'string' ? base.permissionLevel : undefined,
          workspaceId: typeof base.workspaceId === 'string' ? base.workspaceId : undefined,
          workspaceName:
            typeof base.workspaceName === 'string' ? base.workspaceName : undefined,
          isDeleted: false,
          syncedAt: new Date(),
          raw: base,
        },
      ),
    );

    await this.bulkWriteInChunks(this.airtableBaseModel, operations);
  }

  private async upsertTables(
    integration: IntegrationDocument,
    baseId: string,
    tables: AirtableTablePayload[],
  ): Promise<void> {
    const operations = tables.map((table) =>
      this.buildUpsertOperation(
        {
          integrationId: integration._id,
          baseId,
          tableId: table.id,
        },
        {
          integrationId: integration._id,
          baseId,
          tableId: table.id,
          name: table.name,
          description:
            typeof table.description === 'string' ? table.description : undefined,
          primaryFieldId:
            typeof table.primaryFieldId === 'string' ? table.primaryFieldId : undefined,
          fields: this.normalizeTableFields(table),
          views: this.normalizeTableViews(table),
          syncedAt: new Date(),
          raw: table,
        },
      ),
    );

    await this.bulkWriteInChunks(this.airtableTableModel, operations);
  }

  private async upsertRecords(
    integration: IntegrationDocument,
    base: AirtableBasePayload,
    table: AirtableTablePayload,
    records: AirtableRecordPayload[],
  ): Promise<void> {
    const operations = records.map((record) =>
      this.buildUpsertOperation(
        {
          integrationId: integration._id,
          baseId: base.id,
          tableId: table.id,
          recordId: record.id,
        },
        {
          integrationId: integration._id,
          baseId: base.id,
          tableId: table.id,
          tableName: table.name,
          recordId: record.id,
          createdTime: record.createdTime ? new Date(record.createdTime) : undefined,
          fields: record.fields ?? {},
          commentCount:
            typeof record.commentCount === 'number' ? record.commentCount : 0,
          syncedAt: new Date(),
          raw: record,
        },
      ),
    );

    await this.bulkWriteInChunks(this.airtablePageModel, operations);
  }

  private async upsertUsers(
    integration: IntegrationDocument,
    users: NormalizedUser[],
  ): Promise<void> {
    const operations = users.map((user) =>
      this.buildUpsertOperation(
        {
          integrationId: integration._id,
          airtableUserId: user.airtableUserId,
        },
        {
          integrationId: integration._id,
          airtableUserId: user.airtableUserId,
          email: user.email,
          name: user.name,
          firstName: user.firstName,
          lastName: user.lastName,
          role: user.role,
          locale: user.locale,
          timezone: user.timezone,
          isDeleted: false,
          lastSeenAt: new Date(),
          syncedAt: new Date(),
          raw: user.raw,
        },
      ),
    );

    await this.bulkWriteInChunks(this.airtableUserModel, operations);
  }

  private buildUpsertOperation(
    filter: Record<string, unknown>,
    set: Record<string, unknown>,
  ): Record<string, unknown> {
    return {
      updateOne: {
        filter,
        update: {
          $set: set,
        },
        upsert: true,
      },
    };
  }

  private async bulkWriteInChunks(
    model: Model<unknown>,
    operations: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (!operations.length) {
      return;
    }

    const batchSize = Math.max(
      envNumber(this.configService.get<string>('AIRTABLE_SYNC_BATCH_SIZE'), 250),
      1,
    );

    for (let startIndex = 0; startIndex < operations.length; startIndex += batchSize) {
      const batch = operations.slice(startIndex, startIndex + batchSize);

      await model.bulkWrite(batch as never, { ordered: false });
    }
  }

  private normalizeTableFields(table: AirtableTablePayload) {
    if (!Array.isArray(table.fields)) {
      return [];
    }

    return table.fields.map((field) => ({
      id: typeof field.id === 'string' ? field.id : '',
      name: typeof field.name === 'string' ? field.name : '',
      type: typeof field.type === 'string' ? field.type : 'unknown',
      isPrimary:
        typeof field.isPrimary === 'boolean'
          ? field.isPrimary
          : field.id === table.primaryFieldId,
      isComputed: typeof field.isComputed === 'boolean' ? field.isComputed : false,
      description:
        typeof field.description === 'string' ? field.description : undefined,
      options:
        field.options && typeof field.options === 'object'
          ? (field.options as Record<string, unknown>)
          : {},
    }));
  }

  private normalizeTableViews(table: AirtableTablePayload) {
    if (!Array.isArray(table.views)) {
      return [];
    }

    return table.views.map((view) => ({
      id: typeof view.id === 'string' ? view.id : '',
      name: typeof view.name === 'string' ? view.name : '',
      type: typeof view.type === 'string' ? view.type : undefined,
      personalForViewer:
        typeof view.personalForViewer === 'boolean' ? view.personalForViewer : false,
    }));
  }

  private collectUsersFromUnknown(
    value: unknown,
    discoveredUsers: Map<string, NormalizedUser>,
  ): void {
    if (!value) {
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        this.collectUsersFromUnknown(item, discoveredUsers);
      }

      return;
    }

    if (typeof value !== 'object') {
      return;
    }

    const candidate = value as Record<string, unknown>;
    const normalizedUser = this.normalizeUserCandidate(candidate);

    if (normalizedUser) {
      discoveredUsers.set(normalizedUser.airtableUserId, normalizedUser);
    }

    for (const nestedValue of Object.values(candidate)) {
      this.collectUsersFromUnknown(nestedValue, discoveredUsers);
    }
  }

  private normalizeUserCandidate(candidate: Record<string, unknown>): NormalizedUser | null {
    const email = typeof candidate.email === 'string' ? candidate.email.toLowerCase() : undefined;
    const id =
      typeof candidate.id === 'string' && candidate.id.trim()
        ? candidate.id
        : typeof candidate.userId === 'string' && candidate.userId.trim()
          ? candidate.userId
          : undefined;
    const name =
      typeof candidate.name === 'string'
        ? candidate.name
        : typeof candidate.fullName === 'string'
          ? candidate.fullName
          : undefined;
    const candidateType =
      typeof candidate.type === 'string' ? candidate.type.toLowerCase() : undefined;

    if (!id && !email) {
      return null;
    }

    const looksLikeCollaborator =
      Boolean(email) ||
      Boolean(id?.startsWith('usr')) ||
      candidateType === 'collaborator' ||
      candidateType === 'user';

    if (!looksLikeCollaborator) {
      return null;
    }

    return {
      airtableUserId: id ?? `email:${email}`,
      email,
      name,
      firstName:
        typeof candidate.firstName === 'string' ? candidate.firstName : undefined,
      lastName:
        typeof candidate.lastName === 'string' ? candidate.lastName : undefined,
      role: typeof candidate.role === 'string' ? candidate.role : undefined,
      locale: typeof candidate.locale === 'string' ? candidate.locale : undefined,
      timezone:
        typeof candidate.timezone === 'string' ? candidate.timezone : undefined,
      raw: candidate,
    };
  }
}
