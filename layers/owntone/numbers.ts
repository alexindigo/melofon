// OwnTone-private StringNumericLiteral classification. This implementation is
// owned by this plugin and has no runtime dependency on another plugin/parser.
// Mathematical integrality is independent from legacy Number representation.
const MAX_SAFE_DECIMAL = '9007199254740991';

function withinRadix(digits: string, maximum: string): boolean {
  let first = 0;
  while (digits[first] === '0') first++;
  const significant = digits.slice(first).toLowerCase();
  return significant.length < maximum.length ||
    (significant.length === maximum.length && significant <= maximum);
}

function classify(token: string): { safe: boolean } | null {
  if (token === '') return { safe: true }; // Historical blank/whitespace zero.
  if (/^0[xX][0-9a-fA-F]+$/.test(token)) {
    return { safe: withinRadix(token.slice(2), '1fffffffffffff') };
  }
  if (/^0[bB][01]+$/.test(token)) {
    return {
      safe: withinRadix(
        token.slice(2),
        '11111111111111111111111111111111111111111111111111111',
      ),
    };
  }
  if (/^0[oO][0-7]+$/.test(token)) {
    return { safe: withinRadix(token.slice(2), '377777777777777777') };
  }
  const match =
    /^([+-]?)(?:([0-9]+)(?:\.([0-9]*))?|\.([0-9]+))(?:[eE]([+-]?)([0-9]+))?$/
      .exec(token);
  if (!match) return null;
  const fraction = match[3] ?? match[4] ?? '';
  const coefficient = (match[2] ?? '') + fraction;
  let first = 0;
  while (coefficient[first] === '0') first++;
  if (first === coefficient.length) return { safe: true };
  let end = coefficient.length;
  while (coefficient[end - 1] === '0') end--;
  const trailingZeros = coefficient.length - end;
  // Input-sized cancellation thresholds permit exponent saturation without any
  // guessed token limit, coefficient BigInt or expanded decimal representation.
  const bound = coefficient.length + MAX_SAFE_DECIMAL.length;
  let exponent = 0;
  for (const digit of match[6] ?? '') {
    exponent = Math.min(bound, exponent * 10 + digit.charCodeAt(0) - 48);
  }
  if (match[5] === '-') exponent = -exponent;
  const shift = exponent - fraction.length + trailingZeros;
  if (shift < 0) return null;
  const significantLength = end - first;
  const magnitudeLength = significantLength + shift;
  if (magnitudeLength !== MAX_SAFE_DECIMAL.length) {
    return { safe: magnitudeLength < MAX_SAFE_DECIMAL.length };
  }
  for (let i = 0; i < MAX_SAFE_DECIMAL.length; i++) {
    const digit = i < significantLength ? coefficient[first + i] : '0';
    if (digit !== MAX_SAFE_DECIMAL[i]) {
      return { safe: digit < MAX_SAFE_DECIMAL[i] };
    }
  }
  return { safe: true };
}

export function legacyInteger(raw: string): number | null {
  if (!classify(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) && Number.isInteger(value) ? value : null;
}
