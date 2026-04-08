import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { clientAppConfig } from '../../config/client-app-config';
import { AuthService } from '../services/auth.service';

export const airtableAuthGuard: CanActivateFn = async (_route, state) => {
  const authService = inject(AuthService);
  const router = inject(Router);
  const status = await authService.loadStatus();

  if (status.isConnected) {
    return true;
  }

  return router.parseUrl(
    `${clientAppConfig.signInPath}?redirectTo=${encodeURIComponent(state.url)}`,
  );
};
