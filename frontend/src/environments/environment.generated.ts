export const environment = {
  "production": false,
  "appName": "Airtable Integration System",
  "port": 4200,
  "apiBaseUrl": "http://localhost:3007/api",
  "airtableIntegrationKey": "default",
  "signInPath": "/signin",
  "protectedHomePath": "/dashboard",
  "authCallbackPath": "/auth/airtable/callback"
} as const;
