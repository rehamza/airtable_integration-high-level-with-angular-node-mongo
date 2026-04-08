export interface AirtableSyncSummary {
  provider: string;
  integrationKey: string;
  status?: string;
  lastSyncedAt?: string | null;
  startedAt: string;
  finishedAt: string;
  basesSynced: number;
  tablesSynced: number;
  recordsSynced: number;
  usersSynced: number;
  syncedBaseIds: string[];
  syncedTableIds: string[];
}
