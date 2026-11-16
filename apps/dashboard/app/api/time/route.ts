export function GET() {
  return Response.json({ now: Date.now() });
}
