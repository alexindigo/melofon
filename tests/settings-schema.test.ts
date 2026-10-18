import { assertEquals, assertThrows } from '@std/assert';
import {
  parseSetting,
  parseSettingsSchema,
  SettingsValidationError,
} from '../src/settings-schema.ts';

Deno.test('settings schema: scalar decimal, boolean, enum and string constraints', () => {
  for (
    const [schema, text, expected] of [
      [{ type: 'string' }, ' untouched ', ' untouched '],
      [{ type: 'integer', minimum: 5, maximum: 600 }, '60', 60],
      [{ type: 'number' }, '-1.25e2', -125],
      [{ type: 'boolean' }, 'true', true],
      [{ type: 'boolean' }, 'false', false],
      [{ type: 'string', enum: ['on', 'off'] }, 'on', 'on'],
      [
        { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' },
        'abc',
        'abc',
      ],
    ] as const
  ) {
    assertEquals(parseSetting(parseSettingsSchema(schema), text), expected);
  }
  for (
    const [schema, texts] of [
      [{ type: 'integer', minimum: 5, maximum: 600 }, [
        '4',
        '601',
        '5.1',
        '',
        '0x10',
        'Infinity',
        'NaN',
        '9007199254740993',
      ]],
      [{ type: 'number' }, ['', ' ', '1x', '0xff', 'Infinity', '1e999']],
      [{ type: 'boolean' }, ['on', 'TRUE', '0', ' true ']],
      [{ type: 'string', enum: ['on', 'off'] }, ['ON', '']],
      [{ type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' }, [
        'a',
        'abcde',
        'AB',
      ]],
    ] as const
  ) {
    for (const text of texts) {
      assertThrows(
        () => parseSetting(parseSettingsSchema(schema), text),
        SettingsValidationError,
      );
    }
  }
});

Deno.test('settings schema: arrays trim comma separators and validate scalar items', () => {
  const schema = parseSettingsSchema({
    type: 'array',
    items: { type: 'integer', minimum: 1 },
    default: [60, 600],
  });
  assertEquals(parseSetting(schema, '60, 600,1'), [60, 600, 1]);
  assertEquals(parseSetting(schema, ''), []);
  for (const text of ['0', '1,,2', 'x', '1.5']) {
    assertThrows(() => parseSetting(schema, text), SettingsValidationError);
  }
  assertEquals(
    parseSetting(
      parseSettingsSchema({ type: 'array', items: { type: 'boolean' } }),
      'true, false',
    ),
    [true, false],
  );
  assertEquals(
    parseSetting(
      parseSettingsSchema({
        type: 'array',
        items: { type: 'string', enum: ['us', 'ru'] },
      }),
      'us, ru',
    ),
    ['us', 'ru'],
  );
});

Deno.test('settings schema: rejects unknown keywords, malformed constraints and invalid defaults', () => {
  for (
    const declaration of [
      null,
      [],
      {},
      { type: 'object' },
      { type: 'string', unknown: true },
      { type: 'string', minimum: 1 },
      { type: 'integer', pattern: 'x' },
      { type: 'array' },
      { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      { type: 'array', items: { type: 'string', secret: true } },
      { type: 'string', minLength: -1 },
      { type: 'string', maxLength: 1.5 },
      { type: 'string', minLength: 3, maxLength: 2 },
      { type: 'string', pattern: '[' },
      { type: 'number', minimum: Infinity },
      { type: 'number', minimum: 2, maximum: 1 },
      { type: 'string', title: 1 },
      { type: 'string', description: false },
      { type: 'string', enum: [] },
      { type: 'integer', enum: ['1'] },
      { type: 'integer', default: '1' },
      { type: 'integer', minimum: 2, default: 1 },
      { type: 'boolean', default: 'true' },
      { type: 'string', enum: ['on'], default: 'off' },
      { type: 'string', pattern: '^a', default: 'b' },
      { type: 'array', items: { type: 'integer', minimum: 1 }, default: [0] },
    ]
  ) {
    assertThrows(
      () => parseSettingsSchema(declaration),
      SettingsValidationError,
      undefined,
      JSON.stringify(declaration),
    );
  }
});
