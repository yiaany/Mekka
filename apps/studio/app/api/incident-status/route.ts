export async function OPTIONS() {
  return new Response(null, { status: 404 })
}

export async function HEAD() {
  return new Response(null, { status: 404 })
}

export async function GET() {
  return new Response(null, { status: 404 })
}
