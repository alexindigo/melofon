// GET /_/config — list internal state (app.state): operator-owned live
// config. Unauthenticated like /_/health — core has no user concept.
export default async function (
  _request: unknown,
  context: {
    app: {
      state: { list(): Promise<Record<string, string | { isSet: boolean }>> };
    };
  },
) {
  return { config: await context.app.state.list() };
}
