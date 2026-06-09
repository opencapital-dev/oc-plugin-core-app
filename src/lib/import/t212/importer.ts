import type { BrokerImporter, BrokerImportResult, ImportOptions, ParseResult } from '../types';
import { detectT212, t212GridToEvents } from './parse';
import { t212Sim } from './sim';

export const t212Importer: BrokerImporter = {
  format: 't212',
  detect(grid: string[][]): boolean {
    return detectT212(grid);
  },
  parse(grid: string[][], options: ImportOptions): Omit<ParseResult, 'format'> {
    return t212GridToEvents(grid, options);
  },
  simulate(parsed: BrokerImportResult) {
    return t212Sim(parsed);
  },
};
