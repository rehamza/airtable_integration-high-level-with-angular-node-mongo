import { Injectable } from '@nestjs/common';
import { load, type CheerioAPI } from 'cheerio';

export interface ParsedRevisionHistoryChange {
  activityId?: string;
  changeType: string;
  columnType: string;
  fieldName: string;
  columnId?: string;
  groupType?: string;
  oldValue?: unknown;
  newValue?: unknown;
  changedAt: Date;
  changedBy: {
    userId?: string;
    name?: string;
    email?: string;
  };
  rawHtmlSnippet?: string;
  sourceUrl?: string;
}

interface ParseRevisionHistoryInput {
  html: string;
  sourceUrl?: string;
}

interface AirtableActivityUser {
  id?: string;
  email?: string;
  name?: string;
}

interface DeserializedActivityItem {
  columnId?: string;
  columnName?: string;
  columnType?: string;
  previousCellValueObject?: unknown;
  currentCellValueObject?: unknown;
  previousDisplayString?: string;
  currentDisplayString?: string;
}

interface AirtableActivityInfo {
  createdTime?: string;
  originatingUserId?: string;
  diffRowHtml?: string;
  deserializedActivityItems?: DeserializedActivityItem[];
  groupType?: string;
}

interface AirtableRevisionHistoryApiPayload {
  orderedActivityAndCommentIds?: string[];
  rowActivityInfoById?: Record<string, AirtableActivityInfo>;
  rowActivityOrCommentUserObjById?: Record<string, AirtableActivityUser>;
}

@Injectable()
export class AirtableRevisionParserService {
  parseRevisionHistory(input: ParseRevisionHistoryInput): ParsedRevisionHistoryChange[] {
    return this.parseDiffRowHtml({
      diffRowHtml: input.html,
      sourceUrl: input.sourceUrl,
      changedAt: new Date(),
      changedBy: {},
      activityId: undefined,
      groupType: undefined,
    });
  }

  parseRevisionHistoryApiPayload(
    payload: AirtableRevisionHistoryApiPayload,
    input: { sourceUrl?: string } = {},
  ): ParsedRevisionHistoryChange[] {
    const orderedIds = payload.orderedActivityAndCommentIds ?? [];
    const activities = payload.rowActivityInfoById ?? {};
    const users = payload.rowActivityOrCommentUserObjById ?? {};
    const changes: ParsedRevisionHistoryChange[] = [];

    for (const activityId of orderedIds) {
      const activity = activities[activityId];

      if (!activity) {
        continue;
      }

      const user = activity.originatingUserId
        ? users[activity.originatingUserId]
        : undefined;
      const changedAt = activity.createdTime
        ? new Date(activity.createdTime)
        : new Date();
      const safeChangedAt = Number.isNaN(changedAt.getTime()) ? new Date() : changedAt;
      const changedBy = {
        userId: activity.originatingUserId,
        email: user?.email,
        name: user?.name,
      };

      if (activity.diffRowHtml) {
        changes.push(
          ...this.parseDiffRowHtml({
            diffRowHtml: activity.diffRowHtml,
            sourceUrl: input.sourceUrl,
            changedAt: safeChangedAt,
            changedBy,
            activityId,
            groupType: activity.groupType,
          }),
        );
      } else if (activity.deserializedActivityItems?.length) {
        changes.push(
          ...this.parseDeserializedItems(
            activity.deserializedActivityItems,
            {
              sourceUrl: input.sourceUrl,
              changedAt: safeChangedAt,
              changedBy,
              activityId,
              groupType: activity.groupType,
            },
          ),
        );
      }
    }

    return changes.sort((left, right) => left.changedAt.getTime() - right.changedAt.getTime());
  }

  private parseDiffRowHtml(input: {
    diffRowHtml: string;
    sourceUrl?: string;
    changedAt: Date;
    changedBy: {
      userId?: string;
      name?: string;
      email?: string;
    };
    activityId?: string;
    groupType?: string;
  }): ParsedRevisionHistoryChange[] {
    const $ = load(input.diffRowHtml);
    const changes: ParsedRevisionHistoryChange[] = [];
    const seen = new Set<string>();

    $('.historicalCellContainer').each((_, element) => {
      const container = $(element);
      const fieldName = this.normalizeWhitespace(
        container
          .find('[columnid], [columnId], .micro.strong')
          .first()
          .text(),
      );

      if (!fieldName) {
        return;
      }

      const columnId =
        container.find('[columnid]').first().attr('columnid') ??
        container.find('[columnId]').first().attr('columnId') ??
        undefined;
      const valueRoot =
        container.find('.historicalCellValue').first();
      const columnType =
        valueRoot.attr('data-columntype')?.trim() ||
        this.toSnakeCase(fieldName);
      const { oldValue, newValue, isMeaningful } = this.extractValuesFromContainer(
        $,
        container,
      );

      if (!isMeaningful) {
        return;
      }

      const dedupeKey = [
        input.activityId ?? '',
        fieldName,
        columnType,
        input.changedAt.toISOString(),
        JSON.stringify(oldValue ?? null),
        JSON.stringify(newValue ?? null),
      ].join('|');

      if (seen.has(dedupeKey)) {
        return;
      }

      seen.add(dedupeKey);
      changes.push({
        activityId: input.activityId,
        changeType: this.toSnakeCase(fieldName),
        columnType,
        fieldName,
        columnId,
        groupType: input.groupType,
        oldValue,
        newValue,
        changedAt: input.changedAt,
        changedBy: input.changedBy,
        rawHtmlSnippet: $.html(container).slice(0, 4000),
        sourceUrl: input.sourceUrl,
      });
    });

    return changes;
  }

  private extractValuesFromContainer(
    $: CheerioAPI,
    container: ReturnType<CheerioAPI>,
  ): { oldValue?: unknown; newValue?: unknown; isMeaningful: boolean } {
    const valueRoot = container.find('.historicalCellValue').first();
    const classes = valueRoot.attr('class') ?? '';

    if (!valueRoot.length) {
      return { isMeaningful: false };
    }

    if (classes.includes('diff')) {
      const oldBlock =
        valueRoot.find('.colors-background-negative').first().length
          ? valueRoot.find('.colors-background-negative').first()
          : valueRoot.find('.strikethrough').first();
      const newBlock =
        valueRoot.find('.colors-background-success').last().length
          ? valueRoot.find('.colors-background-success').last()
          : valueRoot.children().last();

      return {
        oldValue: this.extractNodeValue($, oldBlock),
        newValue: this.extractNodeValue($, newBlock),
        isMeaningful: true,
      };
    }

    if (classes.includes('nullToValue')) {
      return {
        oldValue: null,
        newValue: this.extractNodeValue($, valueRoot),
        isMeaningful: true,
      };
    }

    if (classes.includes('valueToNull')) {
      return {
        oldValue: this.extractNodeValue($, valueRoot),
        newValue: null,
        isMeaningful: true,
      };
    }

    const textValue = this.extractNodeValue($, valueRoot);

    if (textValue === undefined || textValue === null || textValue === '') {
      return { isMeaningful: false };
    }

    return {
      oldValue: undefined,
      newValue: textValue,
      isMeaningful: true,
    };
  }

  private extractNodeValue(
    $: CheerioAPI,
    node: ReturnType<CheerioAPI>,
  ): unknown {
    if (!node.length) {
      return undefined;
    }

    const textDiffParts = node
      .find('.pre-wrap')
      .toArray()
      .map((element) => this.normalizeTextValue($(element).text()))
      .filter((value) => value !== undefined);

    if (textDiffParts.length > 0) {
      return textDiffParts.join(' ').trim();
    }

    const directText = this.normalizeTextValue(node.text());

    return directText;
  }

  private normalizeTextValue(value: string | undefined): string | undefined {
    if (value === undefined) {
      return undefined;
    }

    const normalized = this.normalizeWhitespace(
      value
        .replace(/\u00a0/g, ' ')
        .replace(/^\s+|\s+$/g, ''),
    );

    if (!normalized) {
      return undefined;
    }

    return normalized;
  }

  private normalizeWhitespace(value: string | undefined): string {
    return (value ?? '').replace(/\s+/g, ' ').trim();
  }

  private parseDeserializedItems(
    items: DeserializedActivityItem[],
    context: {
      sourceUrl?: string;
      changedAt: Date;
      changedBy: { userId?: string; name?: string; email?: string };
      activityId?: string;
      groupType?: string;
    },
  ): ParsedRevisionHistoryChange[] {
    const changes: ParsedRevisionHistoryChange[] = [];

    for (const item of items) {
      const fieldName = item.columnName ?? item.columnId ?? '';

      if (!fieldName) {
        continue;
      }

      const oldValue = this.extractDeserializedValue(
        item.previousDisplayString,
        item.previousCellValueObject,
      );
      const newValue = this.extractDeserializedValue(
        item.currentDisplayString,
        item.currentCellValueObject,
      );

      if (oldValue === undefined && newValue === undefined) {
        continue;
      }

      changes.push({
        activityId: context.activityId,
        changeType: this.toSnakeCase(fieldName),
        columnType: item.columnType ?? this.toSnakeCase(fieldName),
        fieldName,
        columnId: item.columnId,
        groupType: context.groupType,
        oldValue: oldValue ?? null,
        newValue: newValue ?? null,
        changedAt: context.changedAt,
        changedBy: context.changedBy,
        sourceUrl: context.sourceUrl,
      });
    }

    return changes;
  }

  private extractDeserializedValue(
    displayString?: string,
    cellValueObject?: unknown,
  ): unknown {
    if (displayString !== undefined && displayString !== null && displayString !== '') {
      return displayString;
    }

    if (cellValueObject === null || cellValueObject === undefined) {
      return undefined;
    }

    if (typeof cellValueObject === 'string') {
      return cellValueObject || undefined;
    }

    if (typeof cellValueObject === 'number' || typeof cellValueObject === 'boolean') {
      return cellValueObject;
    }

    if (Array.isArray(cellValueObject)) {
      const texts = cellValueObject
        .map((entry) =>
          typeof entry === 'string'
            ? entry
            : typeof entry === 'object' && entry !== null
              ? (entry as Record<string, unknown>).name ??
                (entry as Record<string, unknown>).text ??
                (entry as Record<string, unknown>).label ??
                JSON.stringify(entry)
              : String(entry),
        )
        .filter(Boolean);

      return texts.length ? texts.join(', ') : undefined;
    }

    if (typeof cellValueObject === 'object') {
      const obj = cellValueObject as Record<string, unknown>;

      return obj.name ?? obj.text ?? obj.label ?? JSON.stringify(obj);
    }

    return undefined;
  }

  private toSnakeCase(value: string): string {
    return this.normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
}
