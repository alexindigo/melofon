// Independent consumer parser: scan key/value framing, decode quoted JSON strings.
// No serializer/registry internals are used to interpret output.
import { createLogger } from '../../src/logging.ts';
export function parseLogfmt(line: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  let offset = 0;
  while (offset < line.length) {
    while (line[offset] === ' ') offset++;
    if (offset === line.length) break;
    const equal = line.indexOf('=', offset);
    if (equal < 0) throw new Error('Missing field value');
    const key = line.slice(offset, equal);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || key in values) {
      throw new Error('Invalid or duplicate key');
    }
    offset = equal + 1;
    const start = offset;
    if (line[offset] === '"') {
      offset++;
      for (;;) {
        if (offset >= line.length) throw new Error('Unclosed quoted value');
        if (line[offset] === '\\') {
          offset += 2;
          continue;
        }
        if (line[offset++] === '"') break;
      }
      values[key] = JSON.parse(line.slice(start, offset));
      if (offset < line.length && line[offset] !== ' ') {
        throw new Error('Unseparated value');
      }
    } else {
      while (offset < line.length && line[offset] !== ' ') offset++;
      const value = line.slice(start, offset);
      // deno-lint-ignore no-control-regex -- Independent parser rejects raw record controls.
      if (!value || /[\r\n\x00-\x1f]/.test(value)) {
        throw new Error('Invalid token');
      }
      values[key] = value;
    }
  }
  return values;
}
export function captureLogs() {
  const lines: string[] = [], stdout: string[] = [], stderr: string[] = [];
  const log = createLogger({
    clock: () => new Date('2026-10-07T21:34:56.789Z'),
    sinks: {
      stdout: (line) => {
        lines.push(line.trimEnd());
        stdout.push(line);
      },
      stderr: (line) => {
        lines.push(line.trimEnd());
        stderr.push(line);
      },
    },
  });
  return { log, lines, stdout, stderr, records: () => lines.map(parseLogfmt) };
}
