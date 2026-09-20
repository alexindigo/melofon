// GET /_/outputs — list the registered outputs (boot config included: host,
// port). Core's own CRUD for app.outputs; the Settings UI is a form on this
// API. Unauthenticated like /_/health — core has no user concept.
export default function (
  _request: unknown,
  context: {
    app: {
      outputs: {
        list(): {
          id: string;
          name: string;
          type: string;
          selected: boolean;
          volume: number;
          host?: string;
          port?: number;
        }[];
      };
    };
  },
) {
  return { outputs: context.app.outputs.list() };
}
