// GET /_/libraries — list the scan sources (one OpenSubsonic music folder per
// row). Core's own CRUD for app.libraries; the Settings UI (M5) is a form on
// this API. Unauthenticated like /_/health — core has no user concept.
export default async function (
  _request: unknown,
  context: {
    app: {
      libraries: {
        list(): Promise<{ id: string; name: string; path: string }[]>;
      };
    };
  },
) {
  return { libraries: await context.app.libraries.list() };
}
