export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  if (typeof body !== 'object' || body === null) {
    return Response.json({ ok: false }, { status: 400 });
  }
  const record = body as { phase?: unknown; summary?: { label?: unknown } };
  console.log(
    `collector: phase=${String(record.phase)} label=${String(record.summary?.label ?? 'unknown')}`,
  );
  return Response.json({ ok: true });
}
