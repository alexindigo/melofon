import { isIPv4 } from 'node:net';
import { SpeakerError } from '../speakers.ts';

/** The RAOP transport/resolver currently supports IPv4 and DNS host names. */
export function normalizeAirplayAddress(value: string): string {
  const host = value.trim().toLowerCase().replace(/\.$/, '');
  if (isIPv4(host)) return host;
  if (
    host.length > 253 || /^[\d.]+$/.test(host) ||
    !host.split('.').every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
    )
  ) {
    throw new SpeakerError(
      'invalid_field',
      'Address must be an IPv4 address or DNS host name',
    );
  }
  return host;
}

/** Stable RAOP instance identity, shared by target lookup and browsing. */
export function airplayInstance(
  name: string,
): { id: string; name: string } | null {
  const label = name.replace(/\._raop\._tcp\.local\.?$/i, '');
  const at = label.indexOf('@');
  if (at < 1 || at + 1 >= label.length) return null;
  const hex = label.slice(0, at);
  if (!/^[0-9a-fA-F]{1,16}$/.test(hex)) return null;
  return { id: BigInt(`0x${hex}`).toString(10), name: label.slice(at + 1) };
}
