import { describe, it, expect, vi } from 'vitest';

describe('Cloudflare Proxy Logic', () => {
  // We mock the Cloudflare Environment
  const mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);

  // Simple emulation of the worker logic
  async function handleRequest(request: Request) {
    const url = new URL(request.url);
    const targetUrl = url.searchParams.get('url');
    const allowedOrigins = ['https://OmniConvert.vercel.app', 'http://localhost:3000'];
    const origin = request.headers.get('Origin');

    if (!origin || !allowedOrigins.some(ao => origin.toLowerCase() === ao.toLowerCase())) {
      return new Response('Unauthorized Origin', { status: 403 });
    }

    if (!targetUrl) return new Response('Missing URL', { status: 400 });

    const response = await fetch(targetUrl);
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', origin);
    newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');

    return new Response(response.body, { headers: newHeaders });
  }

  it('should block unauthorized origins', async () => {
    const req = new Request('http://proxy.com?url=http://test.com', {
      headers: { 'Origin': 'https://evil.com' }
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(403);
  });

  it('should allow authorized origins and add security headers', async () => {
    mockFetch.mockResolvedValue(new Response('media-data', {
      headers: { 'Content-Type': 'video/mp4' }
    }));

    const req = new Request('http://proxy.com?url=http://test.com', {
      headers: { 'Origin': 'https://OmniConvert.vercel.app' }
    });
    const res = await handleRequest(req);
    
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://OmniConvert.vercel.app');
    expect(res.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp');
  });
});
