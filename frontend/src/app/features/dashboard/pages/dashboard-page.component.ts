import { CommonModule } from '@angular/common';
import { Component, inject, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatToolbarModule } from '@angular/material/toolbar';
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

  readonly authStatus = this.authService.status;
  readonly isBusy = this.authService.isBusy;
  readonly clientAppConfig = clientAppConfig;

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
}
