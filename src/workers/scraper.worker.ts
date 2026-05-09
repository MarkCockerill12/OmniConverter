/// <reference lib="webworker" />

/**
 * Scraper Worker
 * Uses the Cloudflare Worker's /extract endpoint for server-side video extraction.
 * This replaces the previous Pyodide + yt-dlp approach which broke due to YouTube
 * requiring an external JS runtime that cannot run inside WebAssembly.
 */

let globalProxyUrl: string | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  if (type === 'INIT') {
    try {
      console.log('[Worker] Initializing Scraper (Server-Side Extraction Mode)...');
      globalProxyUrl = payload.proxyUrl;

      if (!globalProxyUrl) {
        throw new Error('Proxy URL is required for server-side extraction');
      }

      console.log('[Worker] Scraper Ready. Proxy:', globalProxyUrl);
      self.postMessage({ type: 'INIT_SUCCESS' });
    } catch (error) {
      console.error('[Worker] Initialization Failed:', error);
      self.postMessage({ type: 'INIT_ERROR', error: String(error) });
    }
  }

  if (type === 'SCRAPE') {
    if (!globalProxyUrl) {
      self.postMessage({ type: 'SCRAPE_ERROR', error: 'Scraper worker not initialized' });
      return;
    }

    try {
      const targetUrl = payload.url;
      console.log('[Worker] Extracting via server:', targetUrl);

      // Build the extract endpoint URL from the proxy base
      const proxyExtractUrl = new URL('/extract', globalProxyUrl).toString();
      
      console.log('[Worker] Routing through Cloudflare Proxy...');
      const response = await fetch(proxyExtractUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ url: targetUrl }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg: string;
        try {
          const errorJson = JSON.parse(errorText);
          errorMsg = errorJson.error || `Server returned ${response.status}`;
        } catch {
          errorMsg = errorText || `Server returned ${response.status}`;
        }
        throw new Error(`Extraction failed: ${errorMsg}`);
      }

      const result = await response.json();

      // Check if extraction returned an error field (partial results)
      if (result.error && (!result.formats || result.formats.length === 0)) {
        throw new Error(result.error);
      }

      // Ensure we have a valid result structure
      let cleanResult: any;
      if (result.isPlaylist) {
        cleanResult = {
          isPlaylist: true,
          title: result.title || 'Playlist',
          thumbnail: result.thumbnail || null,
          platform: result.platform || 'generic',
          videos: result.videos || []
        };
      } else {
        cleanResult = {
          title: result.title || 'Unknown Title',
          thumbnail: result.thumbnail || null,
          duration: result.duration || 'Unknown',
          url: result.url || (result.formats?.[0]?.url || null),
          platform: result.platform || 'generic',
          isAudioOnly: !!result.isAudioOnly,
          formats: (result.formats || []).map((f: any) => ({
            url: f.url,
            ext: f.ext || 'mp4',
            format_note: f.format_note || f.quality || 'Download',
            resolution: f.resolution || 'Unknown',
            filesize: f.filesize || null,
            hasVideo: f.hasVideo,
            hasAudio: f.hasAudio,
          })),
        };
      }

      // If we have a partial result with some formats, warn but still return
      if (result.error && cleanResult.formats.length > 0) {
        console.warn('[Worker] Partial extraction:', result.error);
      }

      let engineSource = result.source || cleanResult.source || 'unknown';
      if (engineSource.includes('backend-pool')) engineSource = 'YT-DLP (Custom Render Backend)';
      else if (engineSource === 'innertube-fallback') engineSource = 'Cloudflare Native Fallback (Innertube)';
      else if (engineSource === 'piped') engineSource = 'Piped API (Playlist)';

      console.log(`\n[Worker] 🟢 EXTRACTION SUCCESSFUL`);
      console.log(`[Worker] 🛠️  ENGINE USED: ${engineSource}`);
      console.log(`[Worker] 🎬 TITLE: ${cleanResult.title} | 📦 FORMATS: ${cleanResult.formats?.length || 0}`);
      
      self.postMessage({ type: 'SCRAPE_SUCCESS', result: cleanResult });
    } catch (error) {
      console.error('[Worker] Scraping Error:', error);
      self.postMessage({ type: 'SCRAPE_ERROR', error: String(error) });
    }
  }
};
