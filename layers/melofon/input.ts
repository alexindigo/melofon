import type { HatContext } from './types.ts';
import { fail } from './errors.ts';

export function fields(context: HatContext, allowed: string[]) {
  const body = context.state.json;
  if (Object.keys(body).some((key) => !allowed.includes(key))) {
    fail(400, 'unknown_field', 'Unknown field');
  }
  return body;
}
export function text(body: Record<string, unknown>, key: string): string {
  if (typeof body[key] !== 'string') {
    fail(400, 'invalid_field', `${key} must be a string`);
  }
  return body[key];
}
export function optionalText(
  body: Record<string, unknown>,
  key: string,
): string | undefined {
  return body[key] === undefined ? undefined : text(body, key);
}
export function nullableText(
  body: Record<string, unknown>,
  key: string,
): string | null | undefined {
  return body[key] === null ? null : optionalText(body, key);
}
export function role(
  body: Record<string, unknown>,
): 'admin' | 'user' | undefined {
  if (
    body.role === undefined || body.role === 'admin' || body.role === 'user'
  ) return body.role;
  fail(400, 'invalid_field', 'role must be admin or user');
}
export function username(body: Record<string, unknown>): string {
  const value = text(body, 'username');
  if (!value.trim()) fail(400, 'invalid_field', 'username must not be empty');
  return value;
}
