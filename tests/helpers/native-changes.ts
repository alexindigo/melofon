// Prepared shards require native coverage regardless of checkout state. Ad-hoc
// runs retain the dirty-native gate, including its fail-open git-error behavior.
export function nativeChanged(
  r: { ok: boolean; stdout: string },
  required = false,
): boolean {
  if (required || !r.ok) return true;
  return r.stdout.split('\n').some((line) =>
    line.slice(3).startsWith('helper/raop/')
  );
}
async function gitStatus(): Promise<{ ok: boolean; stdout: string }> {
  try {
    const out = await new Deno.Command('git', {
      args: [
        'status',
        '--porcelain',
        '--untracked-files=all',
        '--',
        'helper/raop',
      ],
      cwd: new URL('../../', import.meta.url),
      stdout: 'piped',
      stderr: 'null',
    }).output();
    return { ok: out.success, stdout: new TextDecoder().decode(out.stdout) };
  } catch {
    return { ok: false, stdout: '' };
  }
}
export const NATIVE_CHANGED = nativeChanged(
  await gitStatus(),
  Deno.env.get('MELOFON_NATIVE_TESTS') === '1',
);
