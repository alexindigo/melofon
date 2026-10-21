import { fail, notFound, ok } from '#opensubsonic/envelope.ts';
import { presentParam } from '#opensubsonic/params.ts';
import type {
  HatContext,
  StationInput,
  StationResult,
} from '#opensubsonic/types.ts';

// OpenSubsonic's admin-only writes are a protocol limit, not core policy.
export async function stationWriteGuard(
  context: HatContext,
): Promise<Response | undefined> {
  const username = context.state.user!.username;
  const user = await context.app.user.get(username, username);
  if (!user || user === 'forbidden' || user.role !== 'admin') {
    return fail(context, 50, 'User is not authorized for the given operation');
  }
}

export function stationInput(context: HatContext): StationInput | Response {
  const streamUrl = presentParam(context, 'streamUrl');
  if (streamUrl instanceof Response) return streamUrl;
  const name = presentParam(context, 'name');
  if (name instanceof Response) return name;
  return {
    streamUrl,
    name,
    // Spec request spelling differs from response homePageUrl. Navidrome
    // radio.go:116, persistence/radio_repository.go:81-95 replace this field.
    homePageUrl: context.state.params!.get('homepageUrl') || null,
  };
}

export function stationResult(
  context: HatContext,
  result: StationResult | boolean | null,
): Response {
  if (result === null || result === false) return notFound(context);
  if (typeof result === 'object' && 'invalid' in result) {
    return fail(context, 0, result.invalid);
  }
  return ok(context, {});
}
