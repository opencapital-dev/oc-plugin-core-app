export function parseAttributes(input: string): Record<string, string> {
  const trimmed = input.trim();
  if (!trimmed) {
    return {};
  }

  if (trimmed.startsWith('{')) {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).map(([key, value]) => [key, String(value)])
    );
  }

  return Object.fromEntries(
    trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const separator = line.includes('=') ? '=' : ':';
        const [key, ...rest] = line.split(separator);
        if (!key || rest.length === 0) {
          throw new Error(`Invalid attribute line: "${line}"`);
        }
        return [key.trim(), rest.join(separator).trim()];
      })
  );
}

export function formatAttributes(attributes: Record<string, unknown> | undefined | null): string {
  const entries = Object.entries(attributes ?? {});
  if (entries.length === 0) {
    return '—';
  }
  return entries
    .map(([key, value]) => {
      if (value === null || value === undefined) {
        return `${key}=`;
      }
      if (typeof value === 'object') {
        // Plugin namespaces (e.g. attributes.yfinance) — render compact.
        const inner = Object.entries(value as Record<string, unknown>)
          .map(([k, v]) => `${k}: ${formatScalar(v)}`)
          .join(', ');
        return `${key}={${inner}}`;
      }
      return `${key}=${formatScalar(value)}`;
    })
    .join(', ');
}

function formatScalar(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

export const DEFAULT_UPDATED_BY = 'grafana-portal';
