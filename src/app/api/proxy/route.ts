import { NextResponse } from 'next/server';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const targetUrl = searchParams.get('url');

  if (!targetUrl) {
    return new Response('Missing target URL', { status: 400 });
  }

  try {
    const response = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
      redirect: 'follow',
    });

    const newHeaders = new Headers(response.headers);
    
    // Add CORS and COOP/COEP for FFmpeg compatibility if needed
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (error: any) {
    console.error(`[Proxy] Download error: ${error.message}`);
    return new Response(`Proxy error: ${error.message}`, { status: 500 });
  }
}
