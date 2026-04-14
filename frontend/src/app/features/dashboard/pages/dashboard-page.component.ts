import { CommonModule } from '@angular/common';
import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSelectModule } from '@angular/material/select';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatToolbarModule } from '@angular/material/toolbar';
import { AgGridAngular } from 'ag-grid-angular';
import {
  AllCommunityModule,
  ColDef,
  FilterChangedEvent,
  FirstDataRenderedEvent,
  GridApi,
  GetRowIdParams,
  GridReadyEvent,
  SelectionChangedEvent,
  SortChangedEvent,
} from 'ag-grid-community';
import { AirtableScraperService } from '../../../core/airtable/services/airtable-scraper.service';
import { AirtableSyncService } from '../../../core/airtable/services/airtable-sync.service';
import { clientAppConfig } from '../../../core/config/client-app-config';
import { AuthService } from '../../../core/auth/services/auth.service';
import {
  AirtableGridEntity,
  GridColumnMetadata,
  GridFooterSummary,
  GridOptionsResponse,
  GridSelectOption,
} from '../../../core/grid/models/grid.models';
import { GridDataService } from '../../../core/grid/services/grid-data.service';

@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    AgGridAngular,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatIconModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatToolbarModule,
  ],
  templateUrl: './dashboard-page.component.html',
  styleUrl: './dashboard-page.component.scss',
})
export class DashboardPageComponent implements OnInit, OnDestroy {
  private readonly authService = inject(AuthService);
  private readonly airtableSyncService = inject(AirtableSyncService);
  private readonly airtableScraperService = inject(AirtableScraperService);
  private readonly gridDataService = inject(GridDataService);

  readonly authStatus = this.authService.status;
  readonly isBusy = this.authService.isBusy;
  readonly clientAppConfig = clientAppConfig;
  readonly syncRunning = signal(false);
  readonly syncMessage = signal<string | null>(null);
  readonly scraperBusy = signal(false);
  readonly scraperMessage = signal<string | null>(null);
  readonly scraperForm = {
    email: '',
    password: '',
    mfaCode: '',
    limit: 200,
    forceRelogin: false,
  };
  readonly agGridModules = [AllCommunityModule];
  readonly gridLoading = signal(false);
  readonly gridError = signal<string | null>(null);
  readonly gridMode = signal<'standard' | 'global'>('standard');
  readonly gridApi = signal<GridApi | null>(null);
  readonly rowData = signal<Array<Record<string, unknown>>>([]);
  readonly columnDefs = signal<ColDef[]>([]);
  readonly selectedRowsCount = signal(0);
  readonly selectedRowIds = signal<string[]>([]);
  readonly activeIntegrationOptions = signal<GridSelectOption[]>([]);
  readonly collectionOptions = signal<GridSelectOption[]>([]);
  readonly tableOptions = signal<GridSelectOption[]>([]);
  readonly footer = signal<GridFooterSummary>({
    rowsSelected: 0,
    pageSize: 100,
    from: 0,
    to: 0,
    total: 0,
    currentPage: 1,
    totalPages: 1,
  });
  readonly filters = {
    baseId: '',
    entity: 'airtable_pages' as AirtableGridEntity,
    tableId: '',
    search: '',
    page: 1,
    pageSize: 100,
    sortBy: '',
    sortOrder: '' as '' | 'asc' | 'desc',
  };
  readonly defaultColDef: ColDef = {
    sortable: true,
    filter: true,
    floatingFilter: true,
    resizable: true,
    minWidth: 140,
    flex: 1,
    suppressHeaderMenuButton: false,
    valueFormatter: (params) => this.formatCellValue(params.value),
  };
  readonly rowSelection = 'multiple';
  readonly selectionColumnDef: ColDef = {
    width: 56,
    maxWidth: 56,
    pinned: 'left',
    sortable: false,
    filter: false,
    resizable: false,
    suppressHeaderMenuButton: true,
    headerCheckboxSelection: true,
    checkboxSelection: true,
  };
  readonly getRowId = (params: GetRowIdParams<Record<string, unknown>>) =>
    String(
      params.data?.['_id'] ??
        params.data?.['recordId'] ??
        params.data?.['dedupeKey'] ??
        params.data?.['baseId'] ??
        Math.random(),
    );

  private filterDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  get selectedCollectionLabel(): string {
    return (
      this.collectionOptions().find((option) => option.value === this.filters.entity)?.label ??
      this.filters.entity
    );
  }

  get selectedTableLabel(): string | null {
    return (
      this.tableOptions().find((option) => option.value === this.filters.tableId)?.label ?? null
    );
  }

  async ngOnInit(): Promise<void> {
    await this.authService.loadStatus({ force: true });
    await this.loadGridOptions();
    await this.loadGridData();
  }

  ngOnDestroy(): void {
    if (this.filterDebounceTimer) {
      clearTimeout(this.filterDebounceTimer);
    }

    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
  }

  reconnectAirtable(): void {
    this.authService.startAirtableSignIn();
  }

  async refreshConnectionStatus(): Promise<void> {
    await this.authService.loadStatus({ force: true });
    await this.loadGridOptions();
  }

  async refreshAccessToken(): Promise<void> {
    await this.authService.refreshConnection();
  }

  async runFullSync(): Promise<void> {
    this.syncRunning.set(true);
    this.syncMessage.set(null);

    try {
      const result = await this.airtableSyncService.runFullSync();

      this.syncMessage.set(
        `Sync completed: ${result.basesSynced} bases, ${result.tablesSynced} tables, ${result.recordsSynced} records, ${result.usersSynced} users.`,
      );
      await this.authService.loadStatus({ force: true });
      await this.loadGridOptions();
      await this.loadGridData();
    } catch (error) {
      this.syncMessage.set(
        error instanceof Error ? error.message : 'Airtable sync failed.',
      );
      await this.authService.loadStatus({ force: true });
    } finally {
      this.syncRunning.set(false);
    }
  }

  async loginRevisionSession(): Promise<void> {
    this.scraperBusy.set(true);
    this.scraperMessage.set(null);

    try {
      const result = await this.airtableScraperService.refreshSessionCookies({
        email: this.scraperForm.email || undefined,
        password: this.scraperForm.password || undefined,
        mfaCode: this.scraperForm.mfaCode || undefined,
        forceRelogin: this.scraperForm.forceRelogin,
      });

      this.scraperMessage.set(
        `Session cookies refreshed. ${result.cookieCount ?? 0} cookies stored.`,
      );
      await this.authService.loadStatus({ force: true });
      this.clearSensitiveScraperFields();
    } catch (error) {
      this.scraperMessage.set(
        error instanceof Error ? error.message : 'Airtable session login failed.',
      );
    } finally {
      this.scraperBusy.set(false);
    }
  }

  async validateRevisionSession(): Promise<void> {
    this.scraperBusy.set(true);
    this.scraperMessage.set(null);

    try {
      const result = await this.airtableScraperService.validateSessionCookies({
        forceRelogin: false,
      });

      this.scraperMessage.set(result.reason);
      await this.authService.loadStatus({ force: true });
    } catch (error) {
      this.scraperMessage.set(
        error instanceof Error ? error.message : 'Airtable session validation failed.',
      );
    } finally {
      this.scraperBusy.set(false);
    }
  }

  async scrapeRevisionHistory(): Promise<void> {
    this.scraperBusy.set(true);
    this.scraperMessage.set(null);

    try {
      const result = await this.airtableScraperService.scrapeRevisionHistory({
        email: this.scraperForm.email || undefined,
        password: this.scraperForm.password || undefined,
        mfaCode: this.scraperForm.mfaCode || undefined,
        limit: this.scraperForm.limit,
        forceRelogin: this.scraperForm.forceRelogin,
      });

      this.scraperMessage.set(
        `Revision scrape completed. ${result.recordsProcessed}/${result.recordsTotal} pages processed, ${result.revisionsStored} changes stored.`,
      );
      await this.authService.loadStatus({ force: true });
      this.filters.entity = 'airtable_revision_history';
      this.filters.page = 1;
      await this.loadGridOptions();
      await this.loadGridData();
      this.clearSensitiveScraperFields();
    } catch (error) {
      this.scraperMessage.set(
        error instanceof Error ? error.message : 'Revision history scrape failed.',
      );
      await this.authService.loadStatus({ force: true });
    } finally {
      this.scraperBusy.set(false);
    }
  }

  private clearSensitiveScraperFields(): void {
    this.scraperForm.password = '';
    this.scraperForm.mfaCode = '';
  }

  async handleBaseSelectionChange(): Promise<void> {
    this.filters.tableId = '';
    this.filters.page = 1;
    await this.loadGridOptions();
    this.selectDefaultTableIfAvailable();
    await this.loadGridData();
  }

  async handleCollectionSelectionChange(): Promise<void> {
    this.filters.page = 1;
    await this.loadGridOptions();
    this.selectDefaultTableIfAvailable();
    await this.loadGridData();
  }

  async handleTableSelectionChange(): Promise<void> {
    this.filters.page = 1;
    await this.loadGridData();
  }

  handleSearchInput(): void {
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }

    this.searchDebounceTimer = setTimeout(async () => {
      this.filters.page = 1;
      await this.loadGridData();
    }, 350);
  }

  async createNewGrid(): Promise<void> {
    this.gridMode.set('standard');
    this.resetGridFilters({
      keepEntity: false,
    });
    await this.loadGridOptions();
    await this.loadGridData();
  }

  async createGlobalSearchGrid(): Promise<void> {
    this.gridMode.set('global');
    this.resetGridFilters({
      keepEntity: true,
    });
    this.filters.search = '';
    await this.loadGridOptions();
    await this.loadGridData();
  }

  async deleteGrid(): Promise<void> {
    const selectedIds = this.selectedRowIds();

    if (selectedIds.length > 0) {
      this.gridLoading.set(true);
      this.gridError.set(null);

      try {
        const result = await this.gridDataService.deleteRows({
          entity: this.filters.entity,
          ids: selectedIds,
        });

        this.scraperMessage.set(
          `Deleted ${result.deletedCount} selected row(s) from ${result.entity}.`,
        );
        this.gridApi()?.deselectAll();
        this.selectedRowIds.set([]);
        this.selectedRowsCount.set(0);
        await this.loadGridData();
      } catch (error) {
        this.gridError.set(
          error instanceof Error ? error.message : 'Failed to delete selected rows.',
        );
      } finally {
        this.gridLoading.set(false);
      }

      return;
    }

    this.gridApi()?.deselectAll();
    this.selectedRowIds.set([]);
    this.rowData.set([]);
    this.columnDefs.set([]);
    this.selectedRowsCount.set(0);
    this.footer.update((footer) => ({
      ...footer,
      rowsSelected: 0,
      from: 0,
      to: 0,
      total: 0,
      currentPage: 1,
      totalPages: 1,
    }));
  }

  exportCsv(): void {
    this.gridApi()?.exportDataAsCsv({
      fileName: `${this.filters.entity}-${new Date().toISOString().slice(0, 10)}.csv`,
    });
  }

  async goToPreviousPage(): Promise<void> {
    if (this.filters.page <= 1) {
      return;
    }

    this.filters.page -= 1;
    await this.loadGridData();
  }

  async goToNextPage(): Promise<void> {
    if (this.filters.page >= this.footer().totalPages) {
      return;
    }

    this.filters.page += 1;
    await this.loadGridData();
  }

  async handlePageSizeChange(): Promise<void> {
    this.filters.page = 1;
    await this.loadGridData();
  }

  onGridReady(event: GridReadyEvent): void {
    this.gridApi.set(event.api);
  }

  onFirstDataRendered(event: FirstDataRenderedEvent): void {
    if (this.columnDefs().length <= 6) {
      event.api.sizeColumnsToFit();
    }
  }

  onSelectionChanged(event: SelectionChangedEvent): void {
    const selectedRows = event.api.getSelectedRows();
    const selectedCount = selectedRows.length;
    const selectedIds = selectedRows
      .map((row) => row?.['_id'])
      .filter((value): value is string => typeof value === 'string' && value.length > 0);

    this.selectedRowIds.set(selectedIds);
    this.selectedRowsCount.set(selectedCount);
    this.footer.update((footer) => ({
      ...footer,
      rowsSelected: selectedCount,
    }));
  }

  onFilterChanged(event: FilterChangedEvent): void {
    if (this.filterDebounceTimer) {
      clearTimeout(this.filterDebounceTimer);
    }

    this.filterDebounceTimer = setTimeout(async () => {
      this.filters.page = 1;
      await this.loadGridData(event.api.getFilterModel());
    }, 450);
  }

  async onSortChanged(event: SortChangedEvent): Promise<void> {
    const activeSort = event.api
      .getColumnState()
      .find((columnState: { sort?: 'asc' | 'desc' | null; colId: string }) =>
        Boolean(columnState.sort),
      );

    this.filters.sortBy = activeSort?.colId ?? '';
    this.filters.sortOrder = (activeSort?.sort as 'asc' | 'desc' | undefined) ?? '';
    this.filters.page = 1;
    await this.loadGridData(event.api.getFilterModel());
  }

  private async loadGridOptions(): Promise<void> {
    try {
      const options = await this.gridDataService.getOptions({
        baseId: this.filters.baseId || undefined,
        entity: this.filters.entity,
      });

      this.applyGridOptions(options);
    } catch (error) {
      this.gridError.set(error instanceof Error ? error.message : 'Failed to load grid options.');
    }
  }

  private applyGridOptions(options: GridOptionsResponse): void {
    this.activeIntegrationOptions.set(options.activeIntegrationOptions);
    this.collectionOptions.set(options.entityOptions);
    this.tableOptions.set(options.processedEntityOptions);

    if (
      this.filters.baseId &&
      !options.activeIntegrationOptions.some((option) => option.value === this.filters.baseId)
    ) {
      this.filters.baseId = '';
    }

    if (
      this.filters.tableId &&
      !options.processedEntityOptions.some((option) => option.value === this.filters.tableId)
    ) {
      this.filters.tableId = '';
    }

    if (
      this.filters.entity &&
      !options.entityOptions.some((option) => option.value === this.filters.entity)
    ) {
      this.filters.entity = 'airtable_pages';
    }
  }

  private selectDefaultTableIfAvailable(): void {
    if (this.filters.tableId || !this.filters.baseId || this.tableOptions().length === 0) {
      return;
    }

    this.filters.tableId = this.tableOptions()[0]?.value ?? '';
  }

  private async loadGridData(
    filterModel: Record<string, unknown> = this.gridApi()?.getFilterModel() ?? {},
  ): Promise<void> {
    this.gridLoading.set(true);
    this.gridError.set(null);

    try {
      const response = await this.gridDataService.getGridData({
        baseId: this.filters.baseId || undefined,
        entity: this.filters.entity,
        processedEntity: this.filters.tableId || undefined,
        search: this.filters.search || undefined,
        sortBy: this.filters.sortBy || undefined,
        sortOrder: this.filters.sortOrder || undefined,
        page: this.filters.page,
        pageSize: this.filters.pageSize,
        filterModel,
      });

      this.columnDefs.set(this.buildColumnDefinitions(response.columns));
      this.rowData.set(response.rows);
      this.footer.set({
        ...response.footer,
        rowsSelected: this.selectedRowsCount(),
      });

      if (response.rows.length === 0) {
        this.gridApi()?.showNoRowsOverlay();
      } else {
        this.gridApi()?.hideOverlay();
      }
    } catch (error) {
      this.rowData.set([]);
      this.columnDefs.set([]);
      this.selectedRowIds.set([]);
      this.selectedRowsCount.set(0);
      this.footer.update((footer) => ({
        ...footer,
        rowsSelected: 0,
        total: 0,
        from: 0,
        to: 0,
        totalPages: 1,
        currentPage: 1,
      }));
      this.gridError.set(error instanceof Error ? error.message : 'Failed to load grid data.');
      this.gridApi()?.showNoRowsOverlay();
    } finally {
      this.gridLoading.set(false);
    }
  }

  private buildColumnDefinitions(columns: GridColumnMetadata[]): ColDef[] {
    const dynamicColumns = columns.map((column) => ({
      field: column.field,
      colId: column.field,
      headerName: column.headerName,
      sortable: column.sortable,
      filter: column.filterType,
      floatingFilter: column.floatingFilter,
      resizable: column.resizable,
      hide: column.hidden,
      unSortIcon: true,
      minWidth: column.dataType === 'object' ? 220 : 160,
      valueFormatter: (params: { value: unknown }) => this.formatCellValue(params.value),
      comparator:
        column.dataType === 'date'
          ? (left: unknown, right: unknown) =>
              String(left ?? '').localeCompare(String(right ?? ''))
          : undefined,
    }));

    return [this.selectionColumnDef, ...dynamicColumns];
  }

  private formatCellValue(value: unknown): string {
    if (value === null || value === undefined || value === '') {
      return '—';
    }

    if (Array.isArray(value)) {
      return JSON.stringify(value).slice(0, 160);
    }

    if (typeof value === 'object') {
      return JSON.stringify(value).slice(0, 160);
    }

    if (
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)
    ) {
      return new Intl.DateTimeFormat('en-US', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(new Date(value));
    }

    return String(value);
  }

  private resetGridFilters(input: { keepEntity: boolean }): void {
    this.filters.baseId = '';
    this.filters.tableId = '';
    this.filters.search = '';
    this.filters.page = 1;
    this.filters.pageSize = 100;
    this.filters.sortBy = '';
    this.filters.sortOrder = '';

    if (!input.keepEntity) {
      this.filters.entity = 'airtable_pages';
    }

    this.gridApi()?.setFilterModel(null);
  }
}
