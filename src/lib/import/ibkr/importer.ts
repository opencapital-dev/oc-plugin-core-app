import type { BrokerImporter, BrokerImportResult, ImportOptions, ParseResult } from '../types';
import { detectIbkr, ibkrStatementToEvents } from './parse';
import { ibkrSim } from './sim';

export const ibkrImporter: BrokerImporter = {
  format: 'ibkr_statement',
  detect(grid: string[][]): boolean {
    return detectIbkr(grid);
  },
  parse(grid: string[][], options: ImportOptions): Omit<ParseResult, 'format'> {
    return ibkrStatementToEvents(grid, options);
  },
  simulate(parsed: BrokerImportResult) {
    return ibkrSim(parsed);
  },
};
