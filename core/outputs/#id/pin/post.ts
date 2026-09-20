// POST /_/outputs/<id>/pin — deliver a device PIN to the boot (AirPlay
// verification on ATV4+/tvOS 10.2+; the OwnTone hat's PUT carries a pin too,
// but HA may never send one — this is the operator path). 404 on unknown id.
export default async function (
  request: {
    params: { id: string };
    body: { json(): Promise<unknown> };
  },
  context: {
    app: {
      outputs: {
        update(
          id: string,
          opts: { pin?: string },
        ): { id: string } | null;
      };
    };
  },
) {
  let body: unknown;
  try {
    body = await request.body.json();
  } catch {
    return Response.json({ error: 'JSON body with pin is required' }, {
      status: 400,
    });
  }
  const { pin } = (body ?? {}) as { pin?: unknown };
  if (typeof pin !== 'string' || pin.trim() === '') {
    return Response.json({ error: 'pin must be a non-empty string' }, {
      status: 400,
    });
  }
  const updated = context.app.outputs.update(request.params.id, {
    pin: pin.trim(),
  });
  if (updated === null) {
    return Response.json({ error: 'unknown output id' }, { status: 404 });
  }
  return { ok: true };
}
