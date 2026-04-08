export type AirtableGridEntity =
  | 'airtable_bases'
  | 'airtable_tables'
  | 'airtable_pages'
  | 'airtable_users'
  | 'airtable_revision_history';

export interface GridSelectOption {
  value: string;
  label: string;
  secondaryLabel?: string;
}

export interface GridColumnMetadata {
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

export interface GridPagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface GridFooterSummary {
  rowsSelected: number;
  pageSize: number;
  from: number;
  to: number;
  total: number;
  currentPage: number;
  totalPages: number;
}

export interface GridOptionsResponse {
  activeIntegrationOptions: GridSelectOption[];
  entityOptions: GridSelectOption[];
  processedEntityOptions: GridSelectOption[];
  integrationStatus: {
    displayName: string;
    status: string;
    isConnected: boolean;
  };
}

export interface GridDataResponse {
  entity: AirtableGridEntity;
  columns: GridColumnMetadata[];
  rows: Array<Record<string, unknown>>;
  pagination: GridPagination;
  footer: GridFooterSummary;
}
