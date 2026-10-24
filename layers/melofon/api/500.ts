export default function () {
  return Response.json({
    code: 'internal_error',
    message: 'Internal server error',
  }, { status: 500 });
}
