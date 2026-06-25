import { brokerResultToInputs, inputsToRows } from './fromBrokerResult';
import type { BrokerImportResult } from '../import/types';

const empty: BrokerImportResult = {
  trades: [], dividends: [], cashflows: [], fxConversions: [], transferIns: [],
  optionExercises: [], optionAssignments: [], optionExpiries: [], optionMarks: [],
  instrumentsToRegister: [], skipped: 0, errors: [],
};

describe('brokerResultToInputs', () => {
  it('maps a trade request to a TRADE EventInput', () => {
    const result: BrokerImportResult = {
      ...empty,
      trades: [{
        portfolio_id: 'pf', instrument_id: 'KBR', side: 'buy', price: 32.1, quantity: 25,
        currency: 'USD', venue: 'XLON', updated_by: 'x',
      }],
    };
    const inputs = brokerResultToInputs(result);
    expect(inputs).toHaveLength(1);
    expect(inputs[0].event_type).toBe('TRADE');
    expect(inputs[0].instrument_id).toBe('KBR');
    expect(inputs[0].price).toBe(32.1);
  });

  it('excludes option marks (not portfolio events)', () => {
    const result: BrokerImportResult = {
      ...empty,
      optionMarks: [{ instrument_id: 'X', observed_at: 1, close: 2, currency: 'USD', updated_by: 'x' }],
    };
    expect(brokerResultToInputs(result)).toHaveLength(0);
  });

  it('projects inputs into rows the table can render', () => {
    const rows = inputsToRows(brokerResultToInputs({
      ...empty,
      cashflows: [{ portfolio_id: 'pf', type: 'DEPOSIT', amount_native: 5, currency: 'GBP', updated_by: 'x' }],
    }));
    expect(rows[0].event_type).toBe('CASHFLOW');
    expect(rows[0].payload.amount_native).toBe(5);
  });
});
