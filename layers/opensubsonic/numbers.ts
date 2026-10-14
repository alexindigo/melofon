// OpenSubsonic-private StringNumericLiteral classification. Integrality and
// safe magnitude are established from decimal/radix digits before conversion.
// No HTTP, defaults, errors, core services or other plugin implementations.
const MAX_SAFE_DECIMAL = '9007199254740991';

function withinRadix(digits: string, maximum: string): boolean {
  let first = 0;
  while (digits[first] === '0') first++;
  const significant = digits.slice(first).toLowerCase();
  return significant.length < maximum.length ||
    (significant.length === maximum.length && significant <= maximum);
}

function classify(token: string): { safe: boolean } | null {
  if (token === '') return { safe: true }; // Number's historical blank zero.
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
  // Full-token lexical validation has already occurred, even for exact zero.
  if (first === coefficient.length) return { safe: true };
  let end = coefficient.length;
  while (coefficient[end - 1] === '0') end--;
  const trailingZeros = coefficient.length - end;
  // Beyond this input-derived threshold, neither cancelling fractional digits
  // nor the safe-magnitude comparison can change the exponent's classification.
  // Scan every exponent digit with bounded state; never expand powers/BigInts.
  const bound = coefficient.length + MAX_SAFE_DECIMAL.length;
  let exponent = 0;
  for (const digit of match[6] ?? '') {
    exponent = Math.min(bound, exponent * 10 + digit.charCodeAt(0) - 48);
  }
  if (match[5] === '-') exponent = -exponent;
  const shift = exponent - fraction.length + trailingZeros;
  if (shift < 0) return null; // Nonzero exact fraction, including underflow.
  const significantLength = end - first;
  const magnitudeLength = significantLength + shift;
  if (magnitudeLength !== MAX_SAFE_DECIMAL.length) {
    return { safe: magnitudeLength < MAX_SAFE_DECIMAL.length };
  }
  // At most sixteen comparisons; implicit decimal zeros are not materialized.
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

export function safeInteger(raw: string): number | null {
  if (!classify(raw.trim())?.safe) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}
