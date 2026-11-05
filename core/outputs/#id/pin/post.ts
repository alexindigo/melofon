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
      speakers: {
        submitPin(id: string, input: unknown): Promise<unknown>;
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
  try {
    await context.app.speakers.submitPin(request.params.id, {
      pin: pin.trim(),
    });
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error;
    if (error.code === 'not_found') {
      return Response.json({ error: 'unknown output id' }, { status: 404 });
    }
    return Response.json({ error: error.message }, {
      status: error.code === 'pairing_required' || error.code === 'speaker_busy'
        ? 409
        : 400,
    });
  }
  return { ok: true };
}
