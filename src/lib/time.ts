export function nowMicros(): number {
  return Date.now() * 1000;
}

export function formatEventMicros(micros: number): string {
  return new Date(micros / 1000).toLocaleString();
}

export function microsToDatetimeLocalValue(micros: number): string {
  const d = new Date(micros / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function datetimeLocalToMicros(input: string): number {
  const ms = Date.parse(input);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid date/time: "${input}"`);
  }
  return ms * 1000;
}

export function parseOptionalNumber(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    throw new Error(`Invalid numeric value: "${input}"`);
  }
  return value;
}

export function parseOptionalEventTsMicros(input: string): number | undefined {
  const trimmed = input.trim();
  if (!trimmed) {
    return undefined;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid date/time: "${input}"`);
  }
  return ms * 1000;
}

export function durationStr(start: number | null, end: number | null): string {
  if (!start) {
    return '—';
  }
  const tail = end ?? nowMicros();
  const sec = Math.max(0, (tail - start) / 1_000_000);
  if (sec < 60) {
    return `${sec.toFixed(1)}s`;
  }
  if (sec < 3600) {
    return `${(sec / 60).toFixed(1)}m`;
  }
  return `${(sec / 3600).toFixed(2)}h`;
}
