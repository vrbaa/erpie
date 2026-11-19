// Cloudflare Pages Function: same-origin proxy of /api/* to the FastAPI backend.
// No timeout on purpose: the Render free backend can take ~30-60s to wake from sleep.
interface Env {
  BACKEND_ORIGIN?: string;
}

export const onRequest = async (context: { request: Request; env: Env }): Promise<Response> => {
  const { request, env } = context;
  if (!env.BACKEND_ORIGIN) {
    return Response.json({ detail: 'BACKEND_ORIGIN is not configured' }, { status: 500 });
  }
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete('host');
  headers.set('X-Forwarded-Host', url.host);
  const clientIp = request.headers.get('CF-Connecting-IP');
  if (clientIp) headers.set('X-Forwarded-For', clientIp);
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
  return fetch(env.BACKEND_ORIGIN.replace(/\/+$/, '') + url.pathname + url.search, {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    redirect: 'manual',
  });
};
