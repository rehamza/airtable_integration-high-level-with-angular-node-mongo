import { Injectable } from '@nestjs/common';
import { load, type CheerioAPI } from 'cheerio';

export interface ParsedRevisionHistoryChange {
  changeType: 'status' | 'assignee';
  fieldName: 'Status' | 'Assignee';
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

@Injectable()
export class AirtableRevisionParserService {
  parseRevisionHistory(input: ParseRevisionHistoryInput): ParsedRevisionHistoryChange[] {
    const $ = load(input.html);
    const fallbackChangedAt = new Date();
    const changes: ParsedRevisionHistoryChange[] = [];
    const seen = new Set<string>();

    for (const selector of this.getCandidateSelectors()) {
      $(selector).each((_, element) => {
        const root = $(element);
        const text = this.normalizeWhitespace(root.text());

        if (!this.looksRelevant(text)) {
          return;
        }

        const parsedChange = this.parseChangeFromText(text);

        if (!parsedChange) {
          return;
        }

        const changedAt = this.extractChangedAt($, root, fallbackChangedAt);
        const changedBy = this.extractActor(root, text);
        const snippet = $.html(root).slice(0, 4000);
        const dedupeKey = [
          parsedChange.changeType,
          parsedChange.fieldName,
          changedAt.toISOString(),
          JSON.stringify(parsedChange.oldValue ?? null),
          JSON.stringify(parsedChange.newValue ?? null),
          changedBy.userId ?? changedBy.email ?? changedBy.name ?? '',
        ].join('|');

        if (seen.has(dedupeKey)) {
          return;
        }

        seen.add(dedupeKey);
        changes.push({
          ...parsedChange,
          changedAt,
          changedBy,
          rawHtmlSnippet: snippet,
          sourceUrl: input.sourceUrl,
        });
      });
    }

    return changes.sort((left, right) => left.changedAt.getTime() - right.changedAt.getTime());
  }

  private getCandidateSelectors(): string[] {
    return [
      '[data-activity-id]',
      '[data-testid*="activity"]',
      '[data-test-id*="activity"]',
      '[data-change-type]',
      '.activity',
      '.activity-row',
      '.record-activity',
      'article',
      'li',
      'div',
    ];
  }

  private looksRelevant(text: string): boolean {
    return /\b(status|assignee|assigned|unassigned)\b/i.test(text);
  }

  private parseChangeFromText(
    text: string,
  ):
    | Pick<
        ParsedRevisionHistoryChange,
        'changeType' | 'fieldName' | 'oldValue' | 'newValue'
      >
    | null {
    const statusPatterns = [
      /\bstatus\b.*?\bfrom\b\s+(.+?)\s+\bto\b\s+(.+?)(?:[.!]|$)/i,
      /\bstatus\b.*?\bto\b\s+(.+?)(?:[.!]|$)/i,
      /\bstatus\b.*?\bset\b.*?\bto\b\s+(.+?)(?:[.!]|$)/i,
    ];
    const assigneePatterns = [
      /\bassignee\b.*?\bfrom\b\s+(.+?)\s+\bto\b\s+(.+?)(?:[.!]|$)/i,
      /\bassignee\b.*?\bto\b\s+(.+?)(?:[.!]|$)/i,
      /\bassigned\b.*?\bto\b\s+(.+?)(?:[.!]|$)/i,
      /\bunassigned\b(?:\s+(.+?))?(?:[.!]|$)/i,
    ];

    for (const pattern of statusPatterns) {
      const match = text.match(pattern);

      if (match) {
        const oldValue = match[2] ? this.normalizeValue(match[1]) : undefined;
        const newValue = this.normalizeValue(match[2] ?? match[1]);

        return {
          changeType: 'status',
          fieldName: 'Status',
          oldValue,
          newValue,
        };
      }
    }

    for (const pattern of assigneePatterns) {
      const match = text.match(pattern);

      if (match) {
        const isFromToPattern = Boolean(match[2]);
        const oldValue = isFromToPattern ? this.normalizeValue(match[1]) : undefined;
        const newValue = /unassigned/i.test(text)
          ? null
          : this.normalizeValue(match[2] ?? match[1]);

        return {
          changeType: 'assignee',
          fieldName: 'Assignee',
          oldValue,
          newValue,
        };
      }
    }

    return null;
  }

  private extractChangedAt(
    $: CheerioAPI,
    root: ReturnType<CheerioAPI>,
    fallback: Date,
  ): Date {
    const datetimeCandidate =
      root.find('time[datetime]').first().attr('datetime') ??
      root.find('[datetime]').first().attr('datetime') ??
      root.find('[data-timestamp]').first().attr('data-timestamp') ??
      root.find('[data-time]').first().attr('data-time');

    if (datetimeCandidate) {
      const parsed = this.parseDate(datetimeCandidate);

      if (parsed) {
        return parsed;
      }
    }

    const unixTimestamp =
      root.attr('data-timestamp') ??
      root.find('[data-unix-ts]').first().attr('data-unix-ts') ??
      root.find('[data-ts]').first().attr('data-ts');

    if (unixTimestamp) {
      const numericValue = Number(unixTimestamp);

      if (Number.isFinite(numericValue)) {
        const parsed = new Date(
          numericValue > 9_999_999_999 ? numericValue : numericValue * 1000,
        );

        if (!Number.isNaN(parsed.getTime())) {
          return parsed;
        }
      }
    }

    const text = this.normalizeWhitespace(root.text());
    const isoTextMatch = text.match(
      /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/,
    );

    if (isoTextMatch) {
      const parsed = this.parseDate(isoTextMatch[0]);

      if (parsed) {
        return parsed;
      }
    }

    return fallback;
  }

  private extractActor(root: ReturnType<CheerioAPI>, text: string) {
    const userId =
      root.attr('data-user-id') ??
      root.find('[data-user-id]').first().attr('data-user-id') ??
      root.find('[data-collaborator-id]').first().attr('data-collaborator-id');
    const emailHref = root.find('a[href^="mailto:"]').first().attr('href');
    const email =
      (emailHref ? emailHref.replace(/^mailto:/i, '') : undefined) ??
      this.extractEmailFromText(text);
    const name =
      root.attr('data-user-name') ??
      root.find('[data-user-name]').first().attr('data-user-name') ??
      root.find('img[alt]').first().attr('alt') ??
      root.find('[title]').first().attr('title') ??
      this.extractActorNameFromText(text);

    return {
      userId: userId?.trim() || undefined,
      name: name?.trim() || undefined,
      email: email?.trim().toLowerCase() || undefined,
    };
  }

  private extractEmailFromText(text: string): string | undefined {
    const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);

    return emailMatch?.[0];
  }

  private extractActorNameFromText(text: string): string | undefined {
    const actorMatch = text.match(
      /^(.+?)\s+(?:changed|set|updated|assigned|unassigned)\b/i,
    );

    if (!actorMatch) {
      return undefined;
    }

    const candidate = this.normalizeWhitespace(actorMatch[1]);

    if (!candidate || /^(status|assignee)$/i.test(candidate)) {
      return undefined;
    }

    return candidate;
  }

  private normalizeValue(value: string | undefined): unknown {
    if (!value) {
      return undefined;
    }

    const normalized = this.normalizeWhitespace(
      value
        .replace(/^["']|["']$/g, '')
        .replace(/\s+\bat\b\s+\d{1,2}:\d{2}.*$/i, '')
        .replace(/\s+\bon\b\s+\w+\s+\d{1,2},\s+\d{4}.*$/i, ''),
    );

    if (!normalized || /^(none|null|empty|blank|unassigned|no one)$/i.test(normalized)) {
      return null;
    }

    return normalized;
  }

  private normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
  }

  private parseDate(value: string): Date | null {
    const parsed = new Date(value);

    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
}
