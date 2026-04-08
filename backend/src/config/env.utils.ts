const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  return TRUE_VALUES.has(value.trim().toLowerCase());
}

export function envNumber(value: string | undefined, fallback: number): number {
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : fallback;
}

export function envCsv(value: string | undefined, fallback: string[] = []): string[] {
  if (!value) {
    return fallback;
  }

  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
