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

interface AirtableActivityInfo {
  createdTime?: string;
  originatingUserId?: string;
  diffRowHtml?: string;
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

      if (!activity?.diffRowHtml) {
        continue;
      }

      const user = activity.originatingUserId
        ? users[activity.originatingUserId]
        : undefined;
      const changedAt = activity.createdTime
        ? new Date(activity.createdTime)
        : new Date();

      changes.push(
        ...this.parseDiffRowHtml({
          diffRowHtml: activity.diffRowHtml,
          sourceUrl: input.sourceUrl,
          changedAt: Number.isNaN(changedAt.getTime()) ? new Date() : changedAt,
          changedBy: {
            userId: activity.originatingUserId,
            email: user?.email,
            name: user?.name,
          },
          activityId,
          groupType: activity.groupType,
        }),
      );
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

  private toSnakeCase(value: string): string {
    return this.normalizeWhitespace(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
  }
}
