# Airtable API Testing

Base API URL:

```text
http://127.0.0.1:3007/api
```

## 1. OAuth flow

Required backend env values:

- `AIRTABLE_CLIENT_ID`
- `AIRTABLE_CLIENT_SECRET`
- `AIRTABLE_REDIRECT_URI=http://localhost:3007/api/integrations/airtable/callback`

Start the backend:

```bash
cd /home/hamza/Desktop/pj/FSD_project/backend
source ~/.nvm/nvm.sh && nvm use 22.20.0
npm run start
```

Open this URL in the browser:

```text
http://127.0.0.1:3007/api/integrations/airtable/authorize?integrationKey=default
```

What happens:

1. Backend generates PKCE and stores `state` + `codeVerifier`.
2. Browser is redirected to Airtable OAuth.
3. Airtable redirects back to `/api/integrations/airtable/callback`.
4. Backend exchanges the code for tokens.
5. Backend redirects to the frontend callback page.

Check connection status:

```bash
curl "http://127.0.0.1:3007/api/integrations/airtable/status?integrationKey=default"
```

Force token refresh:

```bash
curl -X POST "http://127.0.0.1:3007/api/integrations/airtable/refresh" \
  -H "Content-Type: application/json" \
  -d '{"integrationKey":"default"}'
```

## 2. Sync Airtable data

Run the sync:

```bash
curl -X POST "http://127.0.0.1:3007/api/integrations/airtable/sync" \
  -H "Content-Type: application/json" \
  -d '{"integrationKey":"default","includeRecords":true,"includeUsers":true}'
```

Inspect stored collections:

```bash
curl "http://127.0.0.1:3007/api/integrations/airtable/bases?integrationKey=default"
curl "http://127.0.0.1:3007/api/integrations/airtable/tables?integrationKey=default&baseId=appXXXXXXXXXXXXXX"
curl "http://127.0.0.1:3007/api/integrations/airtable/pages?integrationKey=default&baseId=appXXXXXXXXXXXXXX&tableId=tblXXXXXXXXXXXXXX&page=1&pageSize=25"
curl "http://127.0.0.1:3007/api/integrations/airtable/users?integrationKey=default&page=1&pageSize=25"
```

## 3. Separate scraper testing

The scraper depends on pages already being synced into MongoDB. Do sync first.

### 3.1 Login and store cookies

```bash
curl -X POST "http://127.0.0.1:3007/api/integrations/airtable/session/login" \
  -H "Content-Type: application/json" \
  -d '{
    "integrationKey":"default",
    "email":"YOUR_AIRTABLE_EMAIL",
    "password":"YOUR_AIRTABLE_PASSWORD",
    "mfaCode":"123456",
    "forceRelogin":true
  }'
```

If Airtable does not ask for MFA in that run, omit `mfaCode`.

### 3.2 Validate stored cookies

```bash
curl -X POST "http://127.0.0.1:3007/api/integrations/airtable/session/validate" \
  -H "Content-Type: application/json" \
  -d '{
    "integrationKey":"default"
  }'
```

### 3.3 Scrape one record first

Use one synced record to confirm the scraper works before running a larger batch:

```bash
curl -X POST "http://127.0.0.1:3007/api/integrations/airtable/revision-history/sync" \
  -H "Content-Type: application/json" \
  -d '{
    "integrationKey":"default",
    "baseId":"appXXXXXXXXXXXXXX",
    "tableId":"tblXXXXXXXXXXXXXX",
    "recordId":"recXXXXXXXXXXXXXX",
    "limit":1,
    "forceRelogin":false
  }'
```

Check stored revision history:

```bash
curl "http://127.0.0.1:3007/api/integrations/airtable/revision-history?integrationKey=default&recordId=recXXXXXXXXXXXXXX"
```

Check scrape jobs:

```bash
curl "http://127.0.0.1:3007/api/integrations/airtable/scrape-jobs?integrationKey=default"
curl "http://127.0.0.1:3007/api/integrations/airtable/scrape-jobs/JOB_OBJECT_ID?integrationKey=default"
```

### 3.4 Run a 200-page scraper test

Once a single record works:

```bash
curl -X POST "http://127.0.0.1:3007/api/integrations/airtable/revision-history/sync" \
  -H "Content-Type: application/json" \
  -d '{
    "integrationKey":"default",
    "baseId":"appXXXXXXXXXXXXXX",
    "tableId":"tblXXXXXXXXXXXXXX",
    "limit":200,
    "forceRelogin":false
  }'
```

Then inspect:

```bash
curl "http://127.0.0.1:3007/api/integrations/airtable/revision-history?integrationKey=default&baseId=appXXXXXXXXXXXXXX&tableId=tblXXXXXXXXXXXXXX&page=1&pageSize=100"
curl "http://127.0.0.1:3007/api/integrations/airtable/scrape-jobs?integrationKey=default&jobType=revision_history"
```

## 4. Endpoint catalog

You can also inspect the API surface from the backend itself:

```bash
curl "http://127.0.0.1:3007/api/integrations/airtable/endpoints"
```
