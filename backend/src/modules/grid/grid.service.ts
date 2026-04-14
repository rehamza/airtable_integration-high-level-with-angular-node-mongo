import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { IntegrationsService } from '../integrations/services/integrations.service';
import {
  AirtableBase,
  AirtableBaseDocument,
} from '../airtable/schemas/airtable-base.schema';
import {
  AirtableTable,
  AirtableTableDocument,
} from '../airtable/schemas/airtable-table.schema';
import {
  AirtablePage,
  AirtablePageDocument,
} from '../airtable/schemas/airtable-page.schema';
import {
  AirtableUser,
  AirtableUserDocument,
} from '../airtable/schemas/airtable-user.schema';
import {
  AirtableRevisionHistory,
  AirtableRevisionHistoryDocument,
} from '../airtable/schemas/airtable-revision-history.schema';
import { GridOptionsQueryDto } from './dto/grid-options-query.dto';
import { GridDataQueryDto } from './dto/grid-data-query.dto';
import { GridDeleteDto } from './dto/grid-delete.dto';

type SupportedEntity =
  | 'airtable_bases'
  | 'airtable_tables'
  | 'airtable_pages'
  | 'airtable_users'
  | 'airtable_revision_history';

export interface GridOptionItem {
  value: string;
  label: string;
  secondaryLabel?: string;
}

export interface GridColumnDefinition {
  field: string;
  headerName: string;
  dataType: 'string' | 'number' | 'date' | 'object' | 'boolean';
  filterType: 'agTextColumnFilter' | 'agNumberColumnFilter' | 'agDateColumnFilter';
  sortable: boolean;
  filter: boolean;
  floatingFilter: boolean;
  resizable: boolean;
  hidden?: boolean;
}

interface GridDocumentRow extends Record<string, unknown> {
  _id?: string;
}

interface EntityConfig {
  model: Model<any>;
  defaultSortField: string;
  searchFields: string[];
}

@Injectable()
export class GridService {
  private readonly entityOptions: GridOptionItem[] = [
    { value: 'airtable_bases', label: 'airtable_bases' },
    { value: 'airtable_tables', label: 'airtable_tables' },
    { value: 'airtable_pages', label: 'airtable_pages' },
    { value: 'airtable_users', label: 'airtable_users' },
    { value: 'airtable_revision_history', label: 'airtable_revision_history' },
  ];

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
  ) {}

  async getOptions(query: GridOptionsQueryDto) {
    const integration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      query.integrationKey ?? 'default',
    );
    const [bases, tables] = await Promise.all([
      this.airtableBaseModel
        .find({ integrationId: integration._id })
        .sort({ name: 1 })
        .select({ baseId: 1, name: 1, workspaceName: 1 })
        .lean()
        .exec(),
      query.baseId
        ? this.airtableTableModel
            .find({ integrationId: integration._id, baseId: query.baseId })
            .sort({ name: 1 })
            .select({ tableId: 1, name: 1 })
            .lean()
            .exec()
        : Promise.resolve([]),
    ]);

    return {
      activeIntegrationOptions: bases.map((base) => ({
        value: base.baseId,
        label: base.name,
        secondaryLabel: base.workspaceName,
      })),
      entityOptions: this.entityOptions,
      processedEntityOptions: tables.map((table) => ({
        value: table.tableId,
        label: table.name,
      })),
      integrationStatus: this.integrationsService.toPublicStatus(
        integration,
        'airtable',
        integration.integrationKey,
      ),
    };
  }

  async getGridData(query: GridDataQueryDto) {
    const entity = query.entity as SupportedEntity;
    const integration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      query.integrationKey ?? 'default',
    );
    const entityConfig = this.getEntityConfig(entity);
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 100;
    const skip = (page - 1) * pageSize;
    const filterModel = this.parseFilterModel(query.filterModel);
    const queryFilter = this.buildBaseFilter(entity, String(integration._id), query);
    let sampleDocuments = await entityConfig.model
      .find(queryFilter)
      .sort(this.buildSort(query.sortBy, query.sortOrder, entityConfig.defaultSortField))
      .limit(50)
      .lean()
      .exec();
    if (entity === 'airtable_revision_history') {
      sampleDocuments = await this.enrichRevisionHistoryRows(sampleDocuments, String(integration._id));
    }
    const columns = await this.buildColumns(entity, sampleDocuments, query);
    const globalSearchPaths = this.getGlobalSearchPaths(entity, columns, query);
    const filterExpression = this.buildFilterExpression({
      query,
      columns,
      filterModel,
      globalSearchPaths,
    });
    const mongoFilter =
      filterExpression.length > 0
        ? {
            ...queryFilter,
            $and: filterExpression,
          }
        : queryFilter;
    const [rowsResult, total] = await Promise.all([
      entityConfig.model
        .find(mongoFilter)
        .sort(this.buildSort(query.sortBy, query.sortOrder, entityConfig.defaultSortField))
        .skip(skip)
        .limit(pageSize)
        .lean()
        .exec(),
      entityConfig.model.countDocuments(mongoFilter).exec(),
    ]);
    const rows =
      entity === 'airtable_revision_history'
        ? await this.enrichRevisionHistoryRows(rowsResult, String(integration._id))
        : rowsResult;

    return {
      entity,
      columns,
      rows: rows.map((row: GridDocumentRow) => this.serializeDocument(row)),
      pagination: {
        page,
        pageSize,
        total,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
      footer: {
        rowsSelected: 0,
        pageSize,
        from: total === 0 ? 0 : skip + 1,
        to: Math.min(skip + rows.length, total),
        total,
        currentPage: page,
        totalPages: Math.max(Math.ceil(total / pageSize), 1),
      },
    };
  }

  async deleteRows(body: GridDeleteDto) {
    const entity = body.entity as SupportedEntity;
    const integration = await this.integrationsService.requireOneByProviderAndKey(
      'airtable',
      body.integrationKey ?? 'default',
    );
    const entityConfig = this.getEntityConfig(entity);
    const deleteResult = await entityConfig.model.deleteMany({
      _id: { $in: body.ids },
      integrationId: integration._id,
    });

    return {
      entity,
      requestedCount: body.ids.length,
      deletedCount: deleteResult.deletedCount ?? 0,
    };
  }

  private getEntityConfig(entity: SupportedEntity): EntityConfig {
    switch (entity) {
      case 'airtable_bases':
        return {
          model: this.airtableBaseModel,
          defaultSortField: 'name',
          searchFields: ['baseId', 'name', 'workspaceId', 'workspaceName', 'permissionLevel'],
        };
      case 'airtable_tables':
        return {
          model: this.airtableTableModel,
          defaultSortField: 'name',
          searchFields: ['tableId', 'name', 'description', 'primaryFieldId', 'baseId'],
        };
      case 'airtable_pages':
        return {
          model: this.airtablePageModel,
          defaultSortField: 'createdTime',
          searchFields: ['recordId', 'tableName', 'baseId', 'tableId'],
        };
      case 'airtable_users':
        return {
          model: this.airtableUserModel,
          defaultSortField: 'name',
          searchFields: [
            'airtableUserId',
            'email',
            'name',
            'firstName',
            'lastName',
            'role',
            'locale',
            'timezone',
          ],
        };
      case 'airtable_revision_history':
        return {
          model: this.airtableRevisionHistoryModel,
          defaultSortField: 'changedAt',
          searchFields: [
            'recordId',
            'changeType',
            'fieldName',
            'changedBy.name',
            'changedBy.email',
          ],
        };
      default:
        throw new BadRequestException(`Unsupported entity: ${entity}`);
    }
  }

  private buildBaseFilter(
    entity: SupportedEntity,
    integrationId: string,
    query: GridDataQueryDto,
  ): Record<string, unknown> {
    const filter: Record<string, unknown> = {
      integrationId,
    };

    if (query.baseId) {
      if (entity === 'airtable_bases') {
        filter.baseId = query.baseId;
      } else if (
        entity === 'airtable_tables' ||
        entity === 'airtable_pages' ||
        entity === 'airtable_revision_history'
      ) {
        filter.baseId = query.baseId;
      }
    }

    if (query.processedEntity) {
      if (
        entity === 'airtable_tables' ||
        entity === 'airtable_pages' ||
        entity === 'airtable_revision_history'
      ) {
        filter.tableId = query.processedEntity;
      }
    }

    return filter;
  }

  private async buildColumns(
    entity: SupportedEntity,
    sampleDocuments: GridDocumentRow[],
    query: GridDataQueryDto,
  ): Promise<GridColumnDefinition[]> {
    if (entity === 'airtable_pages') {
      return this.buildPageColumns(sampleDocuments, query);
    }

    const discoveredColumns = new Map<string, GridColumnDefinition>();

    for (const document of sampleDocuments) {
      this.collectColumnsFromValue('', document, discoveredColumns);
    }

    const orderedKeys = [...discoveredColumns.keys()].sort((left, right) => {
      const priority = [
        'uuid',
        'activityId',
        'issueId',
        'recordId',
        'columnType',
        'changeType',
        'oldValue',
        'newValue',
        'createdDate',
        'changedAt',
        'authoredBy',
        'baseId',
        'tableName',
        'tableId',
        'name',
        'email',
      ];
      const leftPriority = priority.indexOf(left);
      const rightPriority = priority.indexOf(right);

      if (leftPriority !== -1 || rightPriority !== -1) {
        return (leftPriority === -1 ? 999 : leftPriority) - (rightPriority === -1 ? 999 : rightPriority);
      }

      return left.localeCompare(right);
    });

    return orderedKeys.map((key) => discoveredColumns.get(key) as GridColumnDefinition);
  }

  private async buildPageColumns(
    sampleDocuments: GridDocumentRow[],
    query: GridDataQueryDto,
  ): Promise<GridColumnDefinition[]> {
    const leadingColumns: GridColumnDefinition[] = [
      this.createColumnDefinition('recordId', 'Record ID', 'string'),
      this.createColumnDefinition('tableName', 'Table', 'string'),
      this.createColumnDefinition('createdTime', 'Created Time', 'date'),
      this.createColumnDefinition('commentCount', 'Comments', 'number'),
    ];

    if (query.processedEntity) {
      const table = await this.airtableTableModel
        .findOne({
          baseId: query.baseId,
          tableId: query.processedEntity,
        })
        .lean()
        .exec();

      if (table?.fields?.length) {
        return [
          ...leadingColumns,
          ...table.fields.map((field) =>
            this.createColumnDefinition(
              `fields.${field.name}`,
              field.name,
              this.mapAirtableFieldType(field.type),
            ),
          ),
        ];
      }
    }

    const dynamicFieldColumns = new Map<string, GridColumnDefinition>();

    for (const document of sampleDocuments) {
      const fields = document.fields;

      if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
        continue;
      }

      for (const [fieldName, value] of Object.entries(fields as Record<string, unknown>)) {
        const fieldPath = `fields.${fieldName}`;

        if (!dynamicFieldColumns.has(fieldPath)) {
          dynamicFieldColumns.set(
            fieldPath,
            this.createColumnDefinition(fieldPath, fieldName, this.inferValueType(value)),
          );
        }
      }
    }

    return [...leadingColumns, ...[...dynamicFieldColumns.values()].sort((a, b) => a.headerName.localeCompare(b.headerName))];
  }

  private getGlobalSearchPaths(
    entity: SupportedEntity,
    columns: GridColumnDefinition[],
    query: GridDataQueryDto,
  ): string[] {
    if (entity === 'airtable_pages') {
      return [
        'recordId',
        'tableName',
        ...columns.filter((column) => column.field.startsWith('fields.')).map((column) => column.field),
      ];
    }

    const config = this.getEntityConfig(entity);
    const discoveredPaths = columns
      .map((column) => column.field)
      .filter((field) => !field.startsWith('raw') && !field.startsWith('metadata'));

    return [...new Set([...config.searchFields, ...discoveredPaths])];
  }

  private async enrichRevisionHistoryRows(
    rows: GridDocumentRow[],
    integrationId: string,
  ): Promise<GridDocumentRow[]> {
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

  private buildFilterExpression(input: {
    query: GridDataQueryDto;
    columns: GridColumnDefinition[];
    filterModel: Record<string, any>;
    globalSearchPaths: string[];
  }): Array<Record<string, unknown>> {
    const expressions: Array<Record<string, unknown>> = [];

    if (input.query.search?.trim()) {
      const searchRegex = this.escapeRegex(input.query.search.trim());

      expressions.push({
        $or: input.globalSearchPaths.map((path) => this.createTextExpression(path, 'contains', searchRegex)),
      });
    }

    for (const [field, model] of Object.entries(input.filterModel)) {
      if (!model) {
        continue;
      }

      const filterType = model.filterType ?? this.getFilterTypeForField(field, input.columns);

      if (filterType === 'number') {
        const numericExpression = this.createNumericExpression(field, model);

        if (numericExpression) {
          expressions.push(numericExpression);
        }

        continue;
      }

      if (filterType === 'date') {
        const dateExpression = this.createDateExpression(field, model);

        if (dateExpression) {
          expressions.push(dateExpression);
        }

        continue;
      }

      const textValue =
        typeof model.filter === 'string'
          ? model.filter.trim()
          : model.filter !== undefined && model.filter !== null
            ? String(model.filter).trim()
            : '';

      if (!textValue) {
        continue;
      }

      expressions.push(
        this.createTextExpression(field, model.type ?? 'contains', this.escapeRegex(textValue)),
      );
    }

    return expressions;
  }

  private createTextExpression(
    field: string,
    type: string,
    value: string,
  ): Record<string, unknown> {
    const input = {
      $toString: {
        $ifNull: [this.toMongoPath(field), ''],
      },
    };
    const startsPattern = `^${value}`;
    const equalsPattern = `^${value}$`;
    const endsPattern = `${value}$`;

    if (type === 'equals') {
      return {
        $expr: {
          $regexMatch: {
            input,
            regex: equalsPattern,
            options: 'i',
          },
        },
      };
    }

    if (type === 'startsWith') {
      return {
        $expr: {
          $regexMatch: {
            input,
            regex: startsPattern,
            options: 'i',
          },
        },
      };
    }

    if (type === 'endsWith') {
      return {
        $expr: {
          $regexMatch: {
            input,
            regex: endsPattern,
            options: 'i',
          },
        },
      };
    }

    return {
      $expr: {
        $regexMatch: {
          input,
          regex: value,
          options: 'i',
        },
      },
    };
  }

  private createNumericExpression(
    field: string,
    model: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const rawFilter = Number(model.filter);
    const rawFilterTo =
      model.filterTo !== undefined && model.filterTo !== null ? Number(model.filterTo) : undefined;
    const type = String(model.type ?? 'equals');

    if (!Number.isFinite(rawFilter) && !Number.isFinite(rawFilterTo)) {
      return null;
    }

    switch (type) {
      case 'equals':
        return { [field]: rawFilter };
      case 'lessThan':
        return { [field]: { $lt: rawFilter } };
      case 'greaterThan':
        return { [field]: { $gt: rawFilter } };
      case 'inRange':
        return {
          [field]: {
            ...(Number.isFinite(rawFilter) ? { $gte: rawFilter } : {}),
            ...(Number.isFinite(rawFilterTo) ? { $lte: rawFilterTo } : {}),
          },
        };
      default:
        return { [field]: rawFilter };
    }
  }

  private createDateExpression(
    field: string,
    model: Record<string, unknown>,
  ): Record<string, unknown> | null {
    const type = String(model.type ?? 'equals');
    const dateFrom = this.parseDateValue(String(model.dateFrom ?? model.filter ?? ''));
    const dateTo = this.parseDateValue(String(model.dateTo ?? model.filterTo ?? ''));

    if (!dateFrom && !dateTo) {
      return null;
    }

    switch (type) {
      case 'equals':
        if (!dateFrom) {
          return null;
        }

        return {
          [field]: {
            $gte: this.startOfDay(dateFrom),
            $lte: this.endOfDay(dateFrom),
          },
        };
      case 'lessThan':
        return dateFrom ? { [field]: { $lt: this.startOfDay(dateFrom) } } : null;
      case 'greaterThan':
        return dateFrom ? { [field]: { $gt: this.endOfDay(dateFrom) } } : null;
      case 'inRange':
        return {
          [field]: {
            ...(dateFrom ? { $gte: this.startOfDay(dateFrom) } : {}),
            ...(dateTo ? { $lte: this.endOfDay(dateTo) } : {}),
          },
        };
      default:
        return dateFrom
          ? {
              [field]: {
                $gte: this.startOfDay(dateFrom),
                $lte: this.endOfDay(dateFrom),
              },
            }
          : null;
    }
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

  private collectColumnsFromValue(
    path: string,
    value: unknown,
    columns: Map<string, GridColumnDefinition>,
  ): void {
    if (!value || typeof value !== 'object' || value instanceof Date) {
      if (path && !columns.has(path)) {
        columns.set(
          path,
          this.createColumnDefinition(path, this.formatHeaderName(path), this.inferValueType(value)),
        );
      }

      return;
    }

    if (Array.isArray(value)) {
      if (path && !columns.has(path)) {
        columns.set(path, this.createColumnDefinition(path, this.formatHeaderName(path), 'object'));
      }

      return;
    }

    const objectValue = value as Record<string, unknown>;
    const objectKeys = Object.keys(objectValue);

    if (!objectKeys.length) {
      if (path && !columns.has(path)) {
        columns.set(path, this.createColumnDefinition(path, this.formatHeaderName(path), 'object'));
      }

      return;
    }

    for (const [key, nestedValue] of Object.entries(objectValue)) {
      if (key === '_id' || key === '__v') {
        continue;
      }

      const nextPath = path ? `${path}.${key}` : key;

      if (
        ['raw', 'metadata', 'filters', 'errorHistory', 'sessionCookies'].includes(key) &&
        !columns.has(nextPath)
      ) {
        columns.set(
          nextPath,
          this.createColumnDefinition(nextPath, this.formatHeaderName(nextPath), 'object'),
        );

        continue;
      }

      this.collectColumnsFromValue(nextPath, nestedValue, columns);
    }
  }

  private createColumnDefinition(
    field: string,
    headerName: string,
    dataType: GridColumnDefinition['dataType'],
  ): GridColumnDefinition {
    return {
      field,
      headerName,
      dataType,
      filterType: dataType === 'number'
        ? 'agNumberColumnFilter'
        : dataType === 'date'
          ? 'agDateColumnFilter'
          : 'agTextColumnFilter',
      sortable: true,
      filter: true,
      floatingFilter: true,
      resizable: true,
      hidden: false,
    };
  }

  private mapAirtableFieldType(fieldType: string): GridColumnDefinition['dataType'] {
    const normalizedType = fieldType.toLowerCase();

    if (
      [
        'number',
        'currency',
        'percent',
        'rating',
        'count',
        'duration',
        'formula',
        'rollup',
      ].includes(normalizedType)
    ) {
      return 'number';
    }

    if (
      ['date', 'dateTime', 'createdTime', 'lastModifiedTime'].map((value) =>
        value.toLowerCase(),
      ).includes(normalizedType)
    ) {
      return 'date';
    }

    if (
      [
        'multipleRecordLinks',
        'multipleCollaborators',
        'multipleSelects',
        'attachments',
        'collaborator',
        'lookup',
      ].map((value) => value.toLowerCase()).includes(normalizedType)
    ) {
      return 'object';
    }

    if (['checkbox', 'toggle'].includes(normalizedType)) {
      return 'boolean';
    }

    return 'string';
  }

  private inferValueType(value: unknown): GridColumnDefinition['dataType'] {
    if (value instanceof Date) {
      return 'date';
    }

    if (typeof value === 'number') {
      return 'number';
    }

    if (typeof value === 'boolean') {
      return 'boolean';
    }

    if (typeof value === 'string') {
      return this.parseDateValue(value) ? 'date' : 'string';
    }

    if (Array.isArray(value) || (value && typeof value === 'object')) {
      return 'object';
    }

    return 'string';
  }

  private formatHeaderName(path: string): string {
    return path
      .split('.')
      .map((segment) => segment.replace(/([a-z])([A-Z])/g, '$1 $2'))
      .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
      .join(' / ');
  }

  private parseFilterModel(value: string | undefined): Record<string, any> {
    if (!value) {
      return {};
    }

    try {
      const parsedValue = JSON.parse(value) as Record<string, any>;

      return typeof parsedValue === 'object' && parsedValue !== null ? parsedValue : {};
    } catch {
      throw new BadRequestException('filterModel must be a valid JSON object.');
    }
  }

  private serializeDocument(document: GridDocumentRow): GridDocumentRow {
    return JSON.parse(JSON.stringify(document)) as GridDocumentRow;
  }

  private getFilterTypeForField(
    field: string,
    columns: GridColumnDefinition[],
  ): 'text' | 'number' | 'date' {
    const column = columns.find((entry) => entry.field === field);

    if (!column) {
      return 'text';
    }

    if (column.dataType === 'number') {
      return 'number';
    }

    if (column.dataType === 'date') {
      return 'date';
    }

    return 'text';
  }

  private toMongoPath(field: string): string {
    return `$${field}`;
  }

  private parseDateValue(value: string): Date | null {
    if (!value || !value.trim()) {
      return null;
    }

    const parsedValue = new Date(value);

    return Number.isNaN(parsedValue.getTime()) ? null : parsedValue;
  }

  private startOfDay(date: Date): Date {
    const nextDate = new Date(date);

    nextDate.setHours(0, 0, 0, 0);

    return nextDate;
  }

  private endOfDay(date: Date): Date {
    const nextDate = new Date(date);

    nextDate.setHours(23, 59, 59, 999);

    return nextDate;
  }

  private escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
}
