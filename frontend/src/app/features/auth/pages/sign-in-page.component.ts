import { CommonModule } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { clientAppConfig } from '../../../core/config/client-app-config';
import { AuthService } from '../../../core/auth/services/auth.service';

@Component({
  selector: 'app-sign-in-page',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCardModule, MatProgressSpinnerModule],
  templateUrl: './sign-in-page.component.html',
  styleUrl: './sign-in-page.component.scss',
})
export class SignInPageComponent implements OnInit {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  readonly clientAppConfig = clientAppConfig;
  readonly status = this.authService.status;
  readonly isBusy = this.authService.isBusy;
  readonly notice = signal<string | null>(null);
  readonly scopedPermissions = computed(() => {
    const scopes = this.status().scopes;

    return scopes.length ? scopes.join(', ') : 'No scopes granted yet.';
  });

  async ngOnInit(): Promise<void> {
    const redirectTo =
      this.route.snapshot.queryParamMap.get('redirectTo') ??
      clientAppConfig.protectedHomePath;
    const oauthError = this.route.snapshot.queryParamMap.get('oauthError');

    if (oauthError) {
      this.notice.set(oauthError);
    }

    const status = await this.authService.loadStatus({ force: true });

    if (status.isConnected) {
      await this.router.navigateByUrl(redirectTo);

      return;
    }

    if (status.errorMessage && !oauthError) {
      this.notice.set(status.errorMessage);
    }
  }

  connectWithAirtable(): void {
    this.authService.startAirtableSignIn();
  }
}
