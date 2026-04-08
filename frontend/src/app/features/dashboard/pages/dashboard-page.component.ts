import { CommonModule } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatToolbarModule } from '@angular/material/toolbar';
import { AirtableScraperService } from '../../../core/airtable/services/airtable-scraper.service';
import { AirtableSyncService } from '../../../core/airtable/services/airtable-sync.service';
import { clientAppConfig } from '../../../core/config/client-app-config';
import { AuthService } from '../../../core/auth/services/auth.service';

@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    MatButtonModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatSlideToggleModule,
    MatToolbarModule,
  ],
  templateUrl: './dashboard-page.component.html',
  styleUrl: './dashboard-page.component.scss',
})
export class DashboardPageComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly airtableSyncService = inject(AirtableSyncService);
  private readonly airtableScraperService = inject(AirtableScraperService);

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

  async ngOnInit(): Promise<void> {
    await this.authService.loadStatus({ force: true });
  }

  reconnectAirtable(): void {
    this.authService.startAirtableSignIn();
  }

  async refreshConnectionStatus(): Promise<void> {
    await this.authService.loadStatus({ force: true });
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
}
