import { Routes } from '@angular/router';
import { airtableAuthGuard } from './core/auth/guards/airtable-auth.guard';

export const routes: Routes = [
  {
    path: '',
    pathMatch: 'full',
    redirectTo: 'dashboard',
  },
  {
    path: 'signin',
    loadComponent: () =>
      import('./features/auth/pages/sign-in-page.component').then(
        (module) => module.SignInPageComponent,
      ),
  },
  {
    path: 'auth/airtable/callback',
    loadComponent: () =>
      import('./features/auth/pages/airtable-callback-page.component').then(
        (module) => module.AirtableCallbackPageComponent,
      ),
  },
  {
    path: 'dashboard',
    canActivate: [airtableAuthGuard],
    loadComponent: () =>
      import('./features/dashboard/pages/dashboard-page.component').then(
        (module) => module.DashboardPageComponent,
      ),
  },
  {
    path: '**',
    redirectTo: 'dashboard',
  },
];
