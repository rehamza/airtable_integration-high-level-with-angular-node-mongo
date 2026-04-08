import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';

const mode = process.argv[2] ?? 'serve';
const rootDir = process.cwd();
const env = {
  ...loadEnvFile(resolve(rootDir, '.env')),
  ...loadEnvFile(resolve(rootDir, '.env.local')),
  ...process.env,
};

syncEnvironmentFile(env);

const ngCliPath = resolve(rootDir, 'node_modules/@angular/cli/bin/ng.js');
const commandArgs = getNgArguments(mode, env);
const child = spawn(process.execPath, [ngCliPath, ...commandArgs], {
  cwd: rootDir,
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => {
  process.exit(code ?? 0);
});

function getNgArguments(currentMode, currentEnv) {
  if (currentMode === 'serve') {
    return [
      'serve',
      '--host',
      currentEnv.NG_APP_HOST ?? '0.0.0.0',
      '--port',
      currentEnv.NG_APP_PORT ?? '4200',
    ];
  }

  if (currentMode === 'watch') {
    return ['build', '--watch', '--configuration', 'development'];
  }

  if (currentMode === 'build') {
    return ['build'];
  }

  if (currentMode === 'test') {
    return ['test'];
  }

  return [currentMode];
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) {
    return {};
  }

  const fileContents = readFileSync(filePath, 'utf8');
  const entries = {};

  for (const rawLine of fileContents.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (!line || line.startsWith('#')) {
      continue;
    }

    const separatorIndex = line.indexOf('=');

    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries[key] = value;
  }

  return entries;
}

function syncEnvironmentFile(currentEnv) {
  const environment = {
    production: currentEnv.NG_APP_ENV === 'production',
    appName: currentEnv.NG_APP_NAME ?? 'Airtable Integration System',
    port: Number(currentEnv.NG_APP_PORT ?? '4200'),
    apiBaseUrl: stripTrailingSlash(
      currentEnv.NG_APP_API_BASE_URL ?? 'http://localhost:3007/api',
    ),
    airtableIntegrationKey: currentEnv.NG_APP_AIRTABLE_INTEGRATION_KEY ?? 'default',
    signInPath: currentEnv.NG_APP_SIGNIN_PATH ?? '/signin',
    protectedHomePath: currentEnv.NG_APP_PROTECTED_HOME_PATH ?? '/dashboard',
    authCallbackPath: currentEnv.NG_APP_AUTH_CALLBACK_PATH ?? '/auth/airtable/callback',
  };
  const filePath = resolve(rootDir, 'src/environments/environment.generated.ts');
  const fileContents = `export const environment = ${JSON.stringify(environment, null, 2)} as const;\n`;

  writeFileSync(filePath, fileContents, 'utf8');
}

function stripTrailingSlash(value) {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}
