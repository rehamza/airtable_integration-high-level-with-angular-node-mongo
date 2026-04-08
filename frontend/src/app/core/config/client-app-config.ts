import { environment } from '../../../environments/environment.generated';

export const clientAppConfig = {
  ...environment,
  apiBaseUrl: environment.apiBaseUrl.replace(/\/$/, ''),
} as const;
