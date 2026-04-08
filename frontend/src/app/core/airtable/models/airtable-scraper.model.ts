export interface AirtableCookieSessionStatus {
  status: string;
  cookieCount?: number;
  cookieExpiresAt?: string | null;
}

export interface AirtableCookieValidationResult {
  valid: boolean;
  checkedAt: string;
  reason: string;
  cookieExpiresAt: string | null;
  recordProbe?: {
    baseId: string;
    tableId: string;
    recordId: string;
  } | null;
}

export interface AirtableRevisionHistoryScrapeResult {
  status: string;
  recordsProcessed: number;
  recordsTotal: number;
  revisionsStored: number;
  statusChangesStored: number;
  assigneeChangesStored: number;
  cookieRefreshes: number;
  jobId: string;
}
