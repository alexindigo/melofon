// Public deployment address: core owns the setting; hats receive this read port.
// Navidrome conf/configuration.go:464-474 separates BaseURL's serving path
// from its origin. The full-address operation can extend this same service.
import type { State } from './state.ts';

export interface PublicAddress {
  /** Current default-listen prefix, empty at the root, never trailing '/'. */
  prefix(): Promise<string>;
}

export function createPublicAddress(state: State): PublicAddress {
  // Accept a path or an HTTP(S) URL, including a trailing slash to normalize.
  // Exclude URL delimiters, credentials, control/space, backslash and cookie
  // delimiters. Dot segments cannot silently change the configured namespace.
  const octet = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
  const ipv4 = `${octet}(?:\\.${octet}){3}`;
  const hex = '[0-9a-fA-F]{1,4}';
  const ipv6 = [
    `(?:${hex}:){7}${hex}`,
    `(?:${hex}:){1,7}:`,
    `(?:${hex}:){1,6}:${hex}`,
    `(?:${hex}:){1,5}(?::${hex}){1,2}`,
    `(?:${hex}:){1,4}(?::${hex}){1,3}`,
    `(?:${hex}:){1,3}(?::${hex}){1,4}`,
    `(?:${hex}:){1,2}(?::${hex}){1,5}`,
    `${hex}:(?:(?::${hex}){1,6})`,
    `:(?:(?::${hex}){1,7}|:)`,
    `(?:${hex}:){6}${ipv4}`,
    `::(?:${hex}:){0,5}${ipv4}`,
    ...Array.from(
      { length: 5 },
      (_, i) => `(?:${hex}:){${i + 1}}:(?:${hex}:){0,${4 - i}}${ipv4}`,
    ),
  ].join('|');
  // WHATWG treats a final decimal/hex-number label as IPv4, not DNS. Only
  // canonical dotted IPv4 above may enter that parser branch (no overflow or
  // ambiguous legacy numeric forms admitted as a hostname).
  const host = `(?:${ipv4}|\\[(?:${ipv6})\\]|` +
    String
      .raw`(?:[a-zA-Z0-9_-]+\.)*(?!(?:[0-9]+|0[xX][0-9a-fA-F]*)\.?(?:[:/]|$))[a-zA-Z0-9_-]+\.?)`;
  const port =
    '(?:[0-5]?[0-9]{1,4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])';
  const authority = `${host}(?::${port})?`;
  const scheme = '[hH][tT][tT][pP][sS]?://';
  const segment = String
    .raw`(?!(?:\.|%2[eE]){1,2}(?:/|$))(?:%[0-9a-fA-F]{2}|[^/?#\s\x00-\x20\x7f\\;%])+`;
  const path = `/(?![_/])${segment}(?:/${segment})*/?`;
  state.declare('server.baseUrl', {
    type: 'string',
    default: '',
    pattern:
      `^(?:|${scheme}${authority}/?|(?:${scheme}${authority})?${path})$(?![\\s\\S])`,
    description: 'Public HTTP(S) URL or serving path, for example /music',
  });
  return Object.freeze({
    async prefix() {
      const value = String(await state.getTyped('server.baseUrl'));
      if (!value) return '';
      return new URL(value, 'http://melofon.invalid').pathname.replace(
        /\/+$/,
        '',
      );
    },
  });
}
