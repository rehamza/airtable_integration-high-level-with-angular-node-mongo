import { CommonModule } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatToolbarModule } from '@angular/material/toolbar';
import { AirtableSyncService } from '../../../core/airtable/services/airtable-sync.service';
import { clientAppConfig } from '../../../core/config/client-app-config';
import { AuthService } from '../../../core/auth/services/auth.service';

@Component({
  selector: 'app-dashboard-page',
  standalone: true,
  imports: [
    CommonModule,
    MatButtonModule,
    MatCardModule,
    MatProgressSpinnerModule,
    MatToolbarModule,
  ],
  templateUrl: './dashboard-page.component.html',
  styleUrl: './dashboard-page.component.scss',
})
export class DashboardPageComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly airtableSyncService = inject(AirtableSyncService);

  readonly authStatus = this.authService.status;
  readonly isBusy = this.authService.isBusy;
  readonly clientAppConfig = clientAppConfig;
  readonly syncRunning = signal(false);
  readonly syncMessage = signal<string | null>(null);

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
}
