export interface IntegrationAuthStatus {
  provider: string;
  integrationKey: string;
  displayName: string;
  status: string;
  authType: string;
  isEnabled: boolean;
  isConnected: boolean;
  scopes: string[];
  expiresAt: string | null;
  connectedAt: string | null;
  lastRefreshedAt: string | null;
  lastAuthError: string | null;
  hasRefreshToken: boolean;
  accessTokenExpired: boolean;
  checked?: boolean;
  errorMessage?: string | null;
}
