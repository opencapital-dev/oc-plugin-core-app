import { formatOcc, parseOcc } from '../occ';

describe('parseOcc', () => {
  test('integer strike round-trips', () => {
    const p = parseOcc('BMY 20JUN25 45 P');
    expect(p.underlying).toBe('BMY');
    expect(p.strike).toBe(45);
    expect(p.optionType).toBe('P');
    expect(p.expiry.toISOString().slice(0, 10)).toBe('2025-06-20');
    expect(p.canonicalId).toBe('BMY 20JUN25 45 P');
  });

  test('fractional strike round-trips', () => {
    const p = parseOcc('GIS 16JAN26 52.5 C');
    expect(p.strike).toBe(52.5);
    expect(p.canonicalId).toBe('GIS 16JAN26 52.5 C');
  });

  test('IBKR statement samples canonicalise', () => {
    expect(parseOcc('RAND 21MAR25 38 P').canonicalId).toBe('RAND 21MAR25 38 P');
    expect(parseOcc('ABBV 30MAY25 187.5 C').canonicalId).toBe('ABBV 30MAY25 187.5 C');
    expect(parseOcc('VZ 26DEC25 40 P').canonicalId).toBe('VZ 26DEC25 40 P');
  });

  test('leading-zero day canonicalises', () => {
    expect(parseOcc('AAPL 5JUL25 200 C').canonicalId).toBe('AAPL 05JUL25 200 C');
  });

  test('case-insensitive input canonicalises uppercase', () => {
    expect(parseOcc('bmy 20jun25 45 p').canonicalId).toBe('BMY 20JUN25 45 P');
  });

  test('whitespace tolerated', () => {
    expect(parseOcc('  BMY 20JUN25 45 P  ').canonicalId).toBe('BMY 20JUN25 45 P');
  });

  test('underlying with dot (BRK.B)', () => {
    const p = parseOcc('BRK.B 16JAN26 400 C');
    expect(p.underlying).toBe('BRK.B');
    expect(p.canonicalId).toBe('BRK.B 16JAN26 400 C');
  });

  test('rejects malformed shape', () => {
    expect(() => parseOcc('not an option')).toThrow(/not an OCC ticker/);
    expect(() => parseOcc('BMY 20JUN25 45 X')).toThrow(/not an OCC ticker/);
  });

  test('rejects invalid date', () => {
    expect(() => parseOcc('BMY 31FEB25 45 P')).toThrow(/invalid OCC date/);
  });

  test('every month abbreviation parses', () => {
    const months = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
    months.forEach((m, idx) => {
      const p = parseOcc(`BMY 15${m}25 45 P`);
      expect(p.expiry.getUTCMonth()).toBe(idx);
    });
  });
});

describe('formatOcc', () => {
  test('integer strike has no decimal', () => {
    const d = new Date(Date.UTC(2025, 5, 20));
    expect(formatOcc('BMY', d, 45, 'P')).toBe('BMY 20JUN25 45 P');
  });

  test('fractional strike strips trailing zeros', () => {
    const d = new Date(Date.UTC(2026, 0, 16));
    expect(formatOcc('GIS', d, 52.5, 'C')).toBe('GIS 16JAN26 52.5 C');
  });

  test('zero-pads single-digit day', () => {
    const d = new Date(Date.UTC(2025, 6, 5));
    expect(formatOcc('AAPL', d, 200, 'C')).toBe('AAPL 05JUL25 200 C');
  });
});
