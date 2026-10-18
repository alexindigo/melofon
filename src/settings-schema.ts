// The shared declaration/encoding contract. Owners supply schemas, never key policy.
export type SettingScalar = string | number | boolean;
export type SettingValue = SettingScalar | SettingScalar[];
export interface SettingsSchema {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'array';
  enum?: SettingValue[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: SettingsSchema;
  default?: SettingValue;
  title?: string;
  description?: string;
}

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsValidationError';
  }
}
function invalid(message: string): never {
  throw new SettingsValidationError(message);
}

const KEYWORDS = new Set([
  'type',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'items',
  'default',
  'title',
  'description',
]);
const TYPES = new Set(['string', 'integer', 'number', 'boolean', 'array']);
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

function validate(
  schema: SettingsSchema,
  value: unknown,
): asserts value is SettingValue {
  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') invalid('must be a string');
      if (
        schema.minLength !== undefined && [...value].length < schema.minLength
      ) invalid(`must have at least ${schema.minLength} characters`);
      if (
        schema.maxLength !== undefined && [...value].length > schema.maxLength
      ) invalid(`must have at most ${schema.maxLength} characters`);
      if (
        schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)
      ) invalid(`must match ${schema.pattern}`);
      break;
    case 'integer':
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        invalid('must be a finite decimal number');
      }
      if (schema.type === 'integer' && !Number.isSafeInteger(value)) {
        invalid('must be a safe integer');
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        invalid(`must be at least ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        invalid(`must be at most ${schema.maximum}`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') invalid('must be true or false');
      break;
    case 'array':
      if (!Array.isArray(value)) invalid('must be an array');
      for (const item of value) validate(schema.items!, item);
      break;
  }
  if (schema.enum !== undefined && !schema.enum.some((v) => equal(v, value))) {
    invalid(`must be one of ${JSON.stringify(schema.enum)}`);
  }
}

/** Validate and copy a declaration; all unsupported vocabulary fails at its owner. */
export function parseSettingsSchema(raw: unknown): SettingsSchema {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    invalid('schema must be an object');
  }
  const input = raw as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!KEYWORDS.has(key)) invalid(`unknown schema keyword: ${key}`);
  }
  if (typeof input.type !== 'string' || !TYPES.has(input.type)) {
    invalid('schema must declare a supported type');
  }
  const numeric = input.type === 'number' || input.type === 'integer';
  for (const key of ['minimum', 'maximum']) {
    if (!(key in input)) continue;
    if (
      !numeric || typeof input[key] !== 'number' || !Number.isFinite(input[key])
    ) invalid(`${key} requires a numeric schema and a finite number`);
  }
  for (const key of ['minLength', 'maxLength']) {
    if (!(key in input)) continue;
    if (
      input.type !== 'string' || !Number.isSafeInteger(input[key]) ||
      (input[key] as number) < 0
    ) invalid(`${key} requires a string schema and a non-negative integer`);
  }
  for (const key of ['title', 'description', 'pattern']) {
    if (key in input && typeof input[key] !== 'string') {
      invalid(`${key} must be a string`);
    }
  }
  if ('pattern' in input) {
    if (input.type !== 'string') invalid('pattern requires a string schema');
    try {
      new RegExp(input.pattern as string);
    } catch {
      invalid('pattern must be a valid regular expression');
    }
  }
  if (
    numeric && input.minimum !== undefined && input.maximum !== undefined &&
    (input.minimum as number) > (input.maximum as number)
  ) invalid('minimum exceeds maximum');
  if (
    input.minLength !== undefined && input.maxLength !== undefined &&
    (input.minLength as number) > (input.maxLength as number)
  ) invalid('minLength exceeds maxLength');
  if (input.type === 'array') {
    const items = parseSettingsSchema(input.items);
    if (items.type === 'array') invalid('array items must be scalar');
  } else if ('items' in input) invalid('items requires an array schema');
  // Fixed keyword order makes equivalent declarations independent of object key order.
  const schema = Object.fromEntries(
    [...KEYWORDS].filter((key) => key in input).map((
      key,
    ) => [key, structuredClone(input[key])]),
  ) as unknown as SettingsSchema;
  if (input.type === 'array') schema.items = parseSettingsSchema(input.items);
  if ('enum' in input) {
    if (!Array.isArray(input.enum) || input.enum.length === 0) {
      invalid('enum must be a non-empty array');
    }
    const withoutEnum = { ...schema, enum: undefined };
    for (const value of input.enum) validate(withoutEnum, value);
  }
  if ('default' in input) {
    validate(schema, input.default);
  }
  return schema;
}

/** Parse the app.state string wire/storage encoding, then enforce its schema. */
export function parseSetting(
  schema: SettingsSchema,
  raw: string,
): SettingValue {
  let value: unknown = raw;
  if (schema.type === 'integer' || schema.type === 'number') {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw.trim())) {
      invalid('must be a decimal number');
    }
    value = Number(raw);
  } else if (schema.type === 'boolean') {
    if (raw !== 'true' && raw !== 'false') invalid('must be true or false');
    value = raw === 'true';
  } else if (schema.type === 'array') {
    value = raw.trim() === ''
      ? []
      : raw.split(',').map((item) => parseSetting(schema.items!, item.trim()));
  }
  validate(schema, value);
  return value;
}
