// Native-test gate: run the helper/raop tests when git shows any change under
// helper/raop/, or when git can't answer (spawn error, nonzero exit, no repo).
// Skip them only when git answers and shows nothing changed there.
export function nativeChanged(r: { ok: boolean; stdout: string }): boolean {
  if (!r.ok) return true;
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
export const NATIVE_CHANGED = nativeChanged(await gitStatus());
