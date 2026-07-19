import { ibkrImporter } from './ibkr/importer';
import { t212Importer } from './t212/importer';
import type {
  BrokerFormat,
  BrokerImporter,
  BrokerImportResult,
  CashBucketSimResult,
  ImportOptions,
  ParseResult,
} from './types';

// Registry of available broker importers. Order matters for auto-detect:
// IBKR's section-style header is more distinctive than T212's flat layout,
// so test for it first and let T212 catch the rest.
const importers: readonly BrokerImporter[] = [ibkrImporter, t212Importer];
const byFormat = new Map<BrokerFormat, BrokerImporter>(
  importers.map((i) => [i.format, i] as const),
);

function pickImporter(grid: string[][], format?: BrokerFormat | 'auto'): BrokerImporter {
  if (format && format !== 'auto') {
    const imp = byFormat.get(format);
    if (!imp) {
      throw new Error(`Unknown broker format: ${format}`);
    }
    return imp;
  }
  for (const imp of importers) {
    if (imp.detect(grid)) {return imp;}
  }
  // No sniff match; default to T212 so a malformed file still produces a
  // structured parser-error list rather than throwing here.
  return t212Importer;
}

export function brokerRowsToEvents(
  grid: string[][],
  options: ImportOptions,
  format?: BrokerFormat | 'auto',
): ParseResult {
  const imp = pickImporter(grid, format);
  const result = imp.parse(grid, options);
  return { ...result, format: imp.format };
}

export function simulateImportedCash(
  parsed: BrokerImportResult,
  format: BrokerFormat,
): CashBucketSimResult {
  const imp = byFormat.get(format);
  if (!imp) {
    throw new Error(`Unknown broker format: ${format}`);
  }
  return imp.simulate(parsed);
}

export { parseCsv } from './parseCsv';
export type {
  BrokerFormat,
  BrokerImporter,
  BrokerImportResult,
  CashBucketSimResult,
  ImportOptions,
  ParseResult,
  TradeSide,
} from './types';
