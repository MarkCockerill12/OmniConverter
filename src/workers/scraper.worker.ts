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
    const targetUrl = payload.url;
    let proxyUrl = payload.proxyUrl || globalProxyUrl;

    // Fallback: If no proxy is provided, use the local API route
    if (!proxyUrl) {
      // In a worker, we can use self.location.origin to point back to the Next.js server
      proxyUrl = self.location.origin + '/api';
      console.log('[Worker] No Proxy provided, defaulting to local API:', proxyUrl);
    }

    try {
      if (proxyUrl && proxyUrl.includes('<YOUR_PI_IP>')) {
        throw new Error('Please update NEXT_PUBLIC_SCRAPER_API_URL in your .env file with your Raspberry Pi\'s actual IP address.');
      }

      console.log('[Worker] Extracting via server:', targetUrl);

      // Build the extract endpoint URL. 
      // If proxyUrl doesn't end with /extract, add it.
      let proxyExtractUrl: string;
      if (proxyUrl.endsWith('/extract')) {
        proxyExtractUrl = proxyUrl;
      } else {
        proxyExtractUrl = new URL('/api/extract', proxyUrl.startsWith('http') ? proxyUrl : self.location.origin).toString();
      }
      
      console.log(`[Worker] Routing through: ${proxyExtractUrl}`);
      let response: Response;
      try {
        response = await fetch(proxyExtractUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({ url: targetUrl }),
        });
      } catch {
        // A network-level failure means the backend itself is unreachable.
        throw new Error(`Could not reach the extraction backend at ${new URL(proxyExtractUrl).origin}. Check that the scraper is online and NEXT_PUBLIC_SCRAPER_API_URL is correct.`);
      }

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

      // Filter and clean formats to show only useful resolutions
      const filteredFormats = (result.formats || [])
        .filter((f: any) => {
          // 1. Remove storyboards (mhtml/images)
          if (f.format_note?.toLowerCase().includes('storyboard')) return false;
          if (f.ext === 'mhtml' || f.ext === 'jpg' || f.ext === 'png') return false;
          
          // 2. Remove very low quality duplicates unless they are the only ones
          if (f.height && f.height < 144) return false;
          
          // 3. Remove "ultranow" or weird protocol fragments
          if (f.url && (f.url.includes('fragment') || f.url.includes('manifest'))) {
            // Keep if it's the only source, but usually these are redundant
          }
          
          return true;
        })
        .map((f: any) => ({
          url: f.url,
          ext: f.ext || 'mp4',
          format_note: f.format_note || f.quality || 'Download',
          resolution: f.resolution || (f.height ? `${f.height}p` : 'Unknown'),
          filesize: f.filesize || null,
          hasVideo: f.hasVideo,
          hasAudio: f.hasAudio,
          height: f.height || 0
        }));

      // Group by resolution to remove duplicates
      const uniqueFormats: any[] = [];
      const seenResolutions = new Set();
      
      // Sort: combined (video+audio) first, then by resolution descending
      filteredFormats.sort((a: any, b: any) => {
        const aComb = (a.hasVideo && a.hasAudio) ? 1 : 0;
        const bComb = (b.hasVideo && b.hasAudio) ? 1 : 0;
        if (bComb !== aComb) return bComb - aComb;
        return b.height - a.height;
      });

      filteredFormats.forEach((f: any) => {
        const key = `${f.resolution}-${f.ext}-${f.hasVideo}-${f.hasAudio}`;
        if (!seenResolutions.has(key)) {
          uniqueFormats.push(f);
          seenResolutions.add(key);
        }
      });

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
          url: result.url || (uniqueFormats?.[0]?.url || null),
          platform: result.platform || 'generic',
          isAudioOnly: !!result.isAudioOnly,
          formats: uniqueFormats.slice(0, 8), // Cap at 8 main formats
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
      self.postMessage({ type: 'SCRAPE_ERROR', error: error instanceof Error ? error.message : String(error) });
    }
  }
};
