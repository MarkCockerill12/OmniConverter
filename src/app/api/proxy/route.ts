/**
 * Streaming media proxy. Used only to bypass CORS on the direct media URLs the
 * scraper returns — the body is piped straight through, never buffered.
 */

const BLOCKED_HOSTS = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[?::1\]?)/i;

export async function GET(req: Request) {
  const targetUrl = new URL(req.url).searchParams.get('url');
  if (!targetUrl) return new Response('Missing target URL', { status: 400 });

  let target: URL;
  try {
    target = new URL(targetUrl);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('bad protocol');
    // Never let the proxy reach back into the private network.
    if (BLOCKED_HOSTS.test(target.hostname)) throw new Error('blocked host');
  } catch {
    return new Response('Invalid target URL', { status: 400 });
  }

  try {
    const upstream = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        // Pass range requests through so seeking/resuming keeps working.
        ...(req.headers.get('range') ? { Range: req.headers.get('range')! } : {}),
      },
      redirect: 'follow',
    });

    const headers = new Headers();
    for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
      const value = upstream.headers.get(key);
      if (value) headers.set(key, value);
    }
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Cross-Origin-Resource-Policy', 'cross-origin');

    return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
  } catch (error: any) {
    console.error(`[Proxy] Download error: ${error.message}`);
    return new Response(`Proxy error: ${error.message}`, { status: 502 });
  }
}
