import { CommonModule } from '@angular/common';
import { Component, inject, OnDestroy, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { clientAppConfig } from '../../../core/config/client-app-config';
import { AuthService } from '../../../core/auth/services/auth.service';

@Component({
  selector: 'app-airtable-callback-page',
  standalone: true,
  imports: [CommonModule, MatButtonModule, MatCardModule, MatProgressSpinnerModule],
  templateUrl: './airtable-callback-page.component.html',
  styleUrl: './airtable-callback-page.component.scss',
})
export class AirtableCallbackPageComponent implements OnInit, OnDestroy {
  private readonly authService = inject(AuthService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private redirectTimer?: ReturnType<typeof setTimeout>;

  readonly viewState = signal({
    loading: true,
    error: false,
    title: 'Finalizing Airtable connection',
    message: 'Validating the saved OAuth state and loading the protected app.',
  });

  async ngOnInit(): Promise<void> {
    const callbackStatus = this.route.snapshot.queryParamMap.get('status');
    const callbackMessage = this.route.snapshot.queryParamMap.get('message');

    if (callbackStatus === 'error') {
      this.viewState.set({
        loading: false,
        error: true,
        title: 'Airtable sign-in failed',
        message:
          callbackMessage ??
          'Airtable rejected the authorization request. Return to the sign-in page and try again.',
      });

      return;
    }

    const status = await this.authService.loadStatus({ force: true });

    if (status.isConnected) {
      this.viewState.set({
        loading: false,
        error: false,
        title: 'Airtable connected',
        message: 'The integration is active. Redirecting you to the protected dashboard.',
      });
      this.redirectTimer = setTimeout(() => {
        void this.router.navigateByUrl(clientAppConfig.protectedHomePath);
      }, 900);

      return;
    }

    this.viewState.set({
      loading: false,
      error: true,
      title: 'Connection could not be confirmed',
      message:
        callbackMessage ??
        status.errorMessage ??
        'The backend callback returned, but the integration is still not active.',
    });
  }

  ngOnDestroy(): void {
    if (this.redirectTimer) {
      clearTimeout(this.redirectTimer);
    }
  }

  returnToSignIn(): void {
    void this.router.navigate(['/signin'], {
      queryParams: {
        oauthError: this.viewState().message,
      },
    });
  }
}
