/**
 * Omni-Convert Cloudflare Proxy (Production Ready)
 * Bypasses CORS and pipes streams from external media sources.
 * Also provides a /extract endpoint for YouTube metadata extraction.
 * Protected by Origin filtering to prevent unauthorized usage.
 */

// ─── Helpers ────────────────────────────────────────────────────────────────

function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes('youtu.be')) {
      return u.pathname.slice(1).split('/')[0];
    }
    if (u.hostname.includes('youtube.com') || u.hostname.includes('youtube-nocookie.com')) {
      if (u.searchParams.has('v')) return u.searchParams.get('v');
      const segments = u.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live', 'v'].includes(segments[0])) {
        return segments[1] || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function formatDuration(seconds) {
  if (!seconds) return 'Unknown';
  const s = parseInt(seconds, 10);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': '*',
  };
}

function jsonResponse(data, origin, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}


function extractPlaylistId(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('list')) return u.searchParams.get('list');
    return null;
  } catch {
    return null;
  }
}

// ─── YouTube Extraction ─────────────────────────────────────────────────────

async function extractYouTube(videoId) {
  // Phase 1: Fetch the YouTube page to get metadata + dynamic API key
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const pageResp = await fetch(pageUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml',
      'Cookie': 'CONSENT=YES+cb.20210328-17-p0.en+FX+999',
    },
  });

  if (!pageResp.ok) {
    // On rate limit, try fallback: oEmbed for metadata + direct innertube for streams
    if (pageResp.status === 429) {
      console.warn('[Extract] YouTube rate limited page fetch, trying fallback...');
      return await extractYouTubeFallback(videoId);
    }
    throw new Error(`YouTube page returned ${pageResp.status}`);
  }

  const html = await pageResp.text();

  // Extract metadata from embedded ytInitialPlayerResponse
  let title = 'Unknown Title';
  let thumbnail = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  let duration = 'Unknown';
  let lengthSeconds = null;

  const playerMatch = html.match(/var ytInitialPlayerResponse\s*=\s*(\{.+?\})\s*;\s*(?:var|<\/script)/s);
  if (playerMatch) {
    try {
      const pageData = JSON.parse(playerMatch[1]);
      const vd = pageData.videoDetails;
      if (vd) {
        title = vd.title || title;
        lengthSeconds = vd.lengthSeconds;
        duration = formatDuration(vd.lengthSeconds);
        const thumbs = vd.thumbnail?.thumbnails || [];
        if (thumbs.length > 0) {
          thumbnail = thumbs[thumbs.length - 1].url;
        }
      }
      // Check if the video is actually playable
      const ps = pageData.playabilityStatus;
      if (ps && ps.status !== 'OK') {
        if (ps.status === 'LOGIN_REQUIRED' || ps.status === 'UNPLAYABLE' || ps.status === 'ERROR') {
          console.warn('[Extract] Video restricted on page load, falling back to TV client...');
          return await extractYouTubeFallback(videoId);
        }
      }
    } catch (e) {
      // JSON parse failed — continue anyway, we'll try to get data from innertube
      console.warn('[Extract] Failed to parse ytInitialPlayerResponse:', e.message);
    }
  }

  // Extract dynamic API key from page
  const apiKeyMatch = html.match(/INNERTUBE_API_KEY['":\s]+(AIza[^'"]+)/);
  const apiKey = apiKeyMatch?.[1] || 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';

  // Phase 2: Use ANDROID_VR client to get direct stream URLs
  // This client returns direct URLs without signature cipher
  const innertubeBody = {
    videoId,
    context: {
      client: {
        hl: 'en',
        gl: 'US',
        clientName: 'ANDROID_VR',
        clientVersion: '1.57.29',
        androidSdkVersion: 30,
        userAgent: 'com.google.android.apps.youtube.vr/1.57.29 (Linux; U; Android 11) gzip',
        osName: 'Android',
        osVersion: '11',
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  };

  const playerResp = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'com.google.android.apps.youtube.vr/1.57.29 (Linux; U; Android 11) gzip',
        'Origin': 'https://www.youtube.com',
        'Referer': 'https://www.youtube.com/',
      },
      body: JSON.stringify(innertubeBody),
    }
  );

  if (!playerResp.ok) {
    // If innertube fails, return metadata-only result
    return {
      title,
      thumbnail,
      duration,
      url: null,
      formats: [],
      error: `Stream extraction failed (HTTP ${playerResp.status}). Metadata only.`,
      source: 'metadata-only',
    };
  }

  const playerData = await playerResp.json();

  // Check playability from innertube response
  const ps = playerData.playabilityStatus;
  if (ps && ps.status !== 'OK') {
    console.warn(`[Extract] Innertube playability: ${ps.status}, falling back to TV client...`);
    return await extractYouTubeFallback(videoId);
  }

  // Update metadata from innertube if available and we didn't get it from page
  if (playerData.videoDetails) {
    const vd = playerData.videoDetails;
    if (title === 'Unknown Title' && vd.title) title = vd.title;
    if (lengthSeconds === null && vd.lengthSeconds) {
      duration = formatDuration(vd.lengthSeconds);
    }
    const thumbs = vd.thumbnail?.thumbnails || [];
    if (thumbs.length > 0) {
      thumbnail = thumbs[thumbs.length - 1].url;
    }
  }

  // Extract formats
  const streamingData = playerData.streamingData;
  if (!streamingData) {
    return {
      title,
      thumbnail,
      duration,
      url: null,
      formats: [],
      error: 'No streaming data returned',
      source: 'metadata-only',
    };
  }

  const allFormats = [
    ...(streamingData.formats || []),
    ...(streamingData.adaptiveFormats || []),
  ];

  // Only include formats with direct URLs
  const directFormats = allFormats.filter(f => f.url && !f.signatureCipher);

  const formats = directFormats.map(f => {
    const hasVideo = f.width && f.height;
    const hasAudio = f.audioQuality || f.audioSampleRate;
    
    let formatNote = '';
    if (hasVideo && hasAudio) {
      formatNote = `${f.height}p (video+audio)`;
    } else if (hasVideo) {
      formatNote = `${f.height}p (video only)`;
    } else if (hasAudio) {
      const quality = (f.audioQuality || '').replace('AUDIO_QUALITY_', '').toLowerCase();
      formatNote = `${quality} audio`;
    }

    return {
      url: f.url,
      ext: (f.mimeType || '').includes('mp4') ? 'mp4'
         : (f.mimeType || '').includes('webm') ? 'webm'
         : (f.mimeType || '').includes('audio/mp4') ? 'm4a'
         : (f.mimeType || '').includes('audio/webm') ? 'weba'
         : 'mp4',
      format_note: formatNote,
      resolution: hasVideo ? `${f.width}x${f.height}` : 'audio only',
      filesize: f.contentLength ? parseInt(f.contentLength, 10) : null,
      quality: f.quality || f.audioQuality || '',
      mimeType: f.mimeType || '',
      width: f.width || 0,
      height: f.height || 0,
      hasVideo: !!hasVideo,
      hasAudio: !!hasAudio,
    };
  });

  // Sort: combined (video+audio) first, then by resolution descending
  formats.sort((a, b) => {
    const aCombined = a.hasVideo && a.hasAudio ? 1 : 0;
    const bCombined = b.hasVideo && b.hasAudio ? 1 : 0;
    if (bCombined !== aCombined) return bCombined - aCombined;
    return (b.height || 0) - (a.height || 0);
  });

  return {
    title,
    thumbnail,
    duration,
    url: formats[0]?.url || null,
    formats: formats.slice(0, 10),
    source: 'innertube-android-vr',
  };
}

// ─── YouTube Fallback (when page fetch is rate-limited) ─────────────────────

async function extractYouTubeFallback(videoId) {
  // Step 1: Get basic metadata from oEmbed (different rate limit pool)
  let title = 'Unknown Title';
  let thumbnail = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
  let duration = 'Unknown';

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const oembedResp = await fetch(oembedUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible)' },
    });
    if (oembedResp.ok) {
      const oembedData = await oembedResp.json();
      title = oembedData.title || title;
      thumbnail = oembedData.thumbnail_url || thumbnail;
    }
  } catch {
    // oEmbed failed too, continue with defaults
  }

  // Step 2: Try innertube ANDROID_VR directly with a known working key
  const knownKeys = [
    'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8',
    'AIzaSyB-63vPrdThhKuerbB2N_l7Kwwcxj6yUAc',
  ];

  for (const apiKey of knownKeys) {
    try {
      const playerResp = await fetch(
        `https://www.youtube.com/youtubei/v1/player?key=${apiKey}&prettyPrint=false`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'com.google.android.apps.youtube.vr/1.57.29 (Linux; U; Android 11) gzip',
            'Origin': 'https://www.youtube.com',
            'Referer': 'https://www.youtube.com/',
          },
          body: JSON.stringify({
            videoId,
            context: {
              client: {
                clientName: 'TVHTML5_SIMPLY_EMBEDDED_PLAYER',
                clientVersion: '2.0',
                hl: 'en', gl: 'US',
                thirdParty: { embedUrl: 'https://www.youtube.com/' }
              },
            },
            contentCheckOk: true,
            racyCheckOk: true,
          }),
        }
      );

      if (!playerResp.ok) {
        console.warn(`[Fallback] TV Client key ${apiKey.slice(0, 10)}... failed HTTP ${playerResp.status}`);
        continue;
      }

      const data = await playerResp.json();
      if (data.playabilityStatus?.status !== 'OK') {
        console.warn(`[Fallback] TV Client key ${apiKey.slice(0, 10)}... playability: ${data.playabilityStatus?.status} - ${data.playabilityStatus?.reason}`);
        continue;
      }

      // Update metadata from innertube
      if (data.videoDetails) {
        title = data.videoDetails.title || title;
        duration = formatDuration(data.videoDetails.lengthSeconds);
        const thumbs = data.videoDetails.thumbnail?.thumbnails || [];
        if (thumbs.length > 0) thumbnail = thumbs[thumbs.length - 1].url;
      }

      const streamingData = data.streamingData;
      if (!streamingData) continue;

      const allFormats = [
        ...(streamingData.formats || []),
        ...(streamingData.adaptiveFormats || []),
      ];

      const directFormats = allFormats.filter(f => f.url && !f.signatureCipher);
      if (directFormats.length === 0) continue;

      const formats = directFormats.map(f => {
        const hasVideo = f.width && f.height;
        const hasAudio = f.audioQuality || f.audioSampleRate;
        let formatNote = '';
        if (hasVideo && hasAudio) formatNote = `${f.height}p (video+audio)`;
        else if (hasVideo) formatNote = `${f.height}p (video only)`;
        else if (hasAudio) {
          const q = (f.audioQuality || '').replace('AUDIO_QUALITY_', '').toLowerCase();
          formatNote = `${q} audio`;
        }

        return {
          url: f.url,
          ext: (f.mimeType || '').includes('mp4') ? 'mp4'
             : (f.mimeType || '').includes('webm') ? 'webm'
             : (f.mimeType || '').includes('audio/mp4') ? 'm4a'
             : (f.mimeType || '').includes('audio/webm') ? 'weba'
             : 'mp4',
          format_note: formatNote,
          resolution: hasVideo ? `${f.width}x${f.height}` : 'audio only',
          filesize: f.contentLength ? parseInt(f.contentLength, 10) : null,
          quality: f.quality || f.audioQuality || '',
          mimeType: f.mimeType || '',
          width: f.width || 0,
          height: f.height || 0,
          hasVideo: !!hasVideo,
          hasAudio: !!hasAudio,
        };
      });

      formats.sort((a, b) => {
        const aCombined = a.hasVideo && a.hasAudio ? 1 : 0;
        const bCombined = b.hasVideo && b.hasAudio ? 1 : 0;
        if (bCombined !== aCombined) return bCombined - aCombined;
        return (b.height || 0) - (a.height || 0);
      });

      return {
        title,
        thumbnail,
        duration,
        url: formats[0]?.url || null,
        formats: formats.slice(0, 10),
        source: 'innertube-fallback',
      };
    } catch {
      continue;
    }
  }

  // If innertube also failed, return metadata-only
  return {
    title,
    thumbnail,
    duration,
    url: null,
    formats: [],
    error: 'YouTube is temporarily rate-limiting requests. Please try again in a few minutes.',
    source: 'metadata-only',
  };
}


async function extractYouTubeBackend(videoId, env) {
  const ytUrl = `https://www.youtube.com/watch?v=${videoId}`;
  
  // Custom yt-dlp Render backend
  const backendInstances = [
    env.BACKEND_API_URL
  ];

  let lastError = null;

  // Try each instance in the pool until one works
  for (const BACKEND_API of backendInstances) {
    if (!BACKEND_API) continue;

    try {
      const [videoRes, audioRes] = await Promise.all([
        fetch(BACKEND_API, {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "OmniConvert/1.0" },
          body: JSON.stringify({ url: ytUrl, videoQuality: "max", filenamePattern: "classic" })
        }),
        fetch(BACKEND_API, {
          method: "POST",
          headers: { "Accept": "application/json", "Content-Type": "application/json", "User-Agent": "OmniConvert/1.0" },
          body: JSON.stringify({ url: ytUrl, isAudioOnly: true, filenamePattern: "classic" })
        })
      ]);

      let videoData = null;
      let audioData = null;

      if (videoRes.ok) videoData = await videoRes.json();
      if (audioRes.ok) audioData = await audioRes.json();

      if ((!videoData || videoData.status === "error") && (!audioData || audioData.status === "error")) {
          throw new Error(`Instance ${BACKEND_API} failed. Video: ${videoData?.error?.code}, Audio: ${audioData?.error?.code}`);
      }

      let title = "YouTube Video";
    let thumbnail = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;
    
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        title = oembedData.title || title;
        thumbnail = oembedData.thumbnail_url || thumbnail;
      }
    } catch(e) {}

    const formats = [];
    if (videoData && videoData.url) {
      formats.push({ url: videoData.url, ext: "mp4", format_note: "Max Quality Video (Backend)", hasVideo: true, hasAudio: true });
    }
    if (audioData && audioData.url) {
      formats.push({ url: audioData.url, ext: "mp3", format_note: "High Quality Audio (Backend)", hasVideo: false, hasAudio: true });
    }

      return {
        title,
        thumbnail,
        duration: "Unknown",
        formats,
        source: `backend-pool (${BACKEND_API})`
      };
    } catch (err) {
      console.warn(`[Backend Pool] ${err.message}`);
      lastError = err;
      continue; // Move to the next instance in the pool
    }
  } // end of for loop

  // If ALL instances in the pool fail, fallback to Innertube
  console.error("[Extract] Entire Backend Pool failed, falling back to innertube:", lastError?.message);
  const fallbackResult = await extractYouTube(videoId);
  if (fallbackResult.error) {
    fallbackResult.error = `Backend Pool Error: ${lastError?.message} | Fallback Error: ${fallbackResult.error}`;
    fallbackResult.source = 'backend-pool-failed';
  }
  return fallbackResult;
}

async function extractYouTubePlaylist(playlistId) {
  try {
    const res = await fetch(`https://pipedapi.kavin.rocks/playlists/${playlistId}`);
    if (!res.ok) throw new Error("Piped API failed to fetch playlist");
    const data = await res.json();
    
    const videos = (data.relatedStreams || []).map(v => ({
      title: v.title,
      url: `https://www.youtube.com${v.url}`,
      thumbnail: v.thumbnail || `https://i.ytimg.com/vi/${v.url.split('?v=')[1]}/hqdefault.jpg`,
      duration: formatDuration(v.duration)
    }));

    return {
      isPlaylist: true,
      title: data.name || "YouTube Playlist",
      thumbnail: data.thumbnailUrl || (videos[0] ? videos[0].thumbnail : null),
      videos,
      source: "piped-playlist"
    };
  } catch (err) {
    throw new Error(`Failed to extract playlist: ${err.message}`);
  }
}

// ─── Generic oEmbed extraction for other platforms ──────────────────────────


function detectPlatform(url) {
  const h = new URL(url).hostname.replace('www.', '');
  if (h.includes('youtube.com') || h.includes('youtu.be')) return 'youtube';
  if (h.includes('reddit.com') || h.includes('redd.it'))  return 'reddit';
  if (h.includes('twitter.com') || h.includes('x.com'))   return 'twitter';
  if (h.includes('spotify.com'))                           return 'spotify';
  if (h.includes('tiktok.com'))                            return 'tiktok';
  if (h.includes('instagram.com'))                         return 'instagram';
  if (h.includes('vimeo.com'))                             return 'vimeo';
  if (h.includes('soundcloud.com'))                        return 'soundcloud';
  if (h.includes('twitch.tv'))                             return 'twitch';
  return 'generic';
}

async function extractReddit(url) {
  const jsonUrl = url.replace(/\/$/, '') + '.json';
  const res = await fetch(jsonUrl, { headers: { 'User-Agent': 'OmniConvert/1.0' } });
  if (!res.ok) throw new Error('Reddit fetch failed');
  const data = await res.json();
  const post = data[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error('Reddit post not found');
  
  const rv = post.secure_media?.reddit_video || post.media?.reddit_video;
  if (rv) {
    const videoUrl = rv.fallback_url.replace('?source=fallback', '');
    const audioUrl = videoUrl.replace(/DASH_\d+\.mp4/, 'DASH_audio.mp4');
    return {
      title: post.title,
      thumbnail: post.thumbnail !== 'default' ? post.thumbnail : null,
      duration: rv.duration ? formatDuration(rv.duration) : 'Unknown',
      formats: [
        { url: videoUrl, ext: 'mp4', format_note: `${rv.height}p (video only)`, hasVideo: true, hasAudio: false },
        { url: audioUrl, ext: 'mp4', format_note: 'Audio', hasVideo: false, hasAudio: true },
      ],
      audioUrl,
      source: 'reddit',
    };
  }
  throw new Error('No video found in Reddit post');
}

async function extractTwitter(url) {
  const tokenRes = await fetch('https://api.twitter.com/1.1/guest/activate.json', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
    },
  });
  if (!tokenRes.ok) throw new Error('Twitter guest token failed');
  const { guest_token } = await tokenRes.json();
  
  const tweetIdMatch = url.match(/status\/(\d+)/);
  if (!tweetIdMatch) throw new Error('Could not extract tweet ID');
  const tweetId = tweetIdMatch[1];
  
  const variables = encodeURIComponent(JSON.stringify({ tweetId, withCommunity: false, includePromotedContent: false, withVoice: false }));
  const features = encodeURIComponent(JSON.stringify({
    creator_subscriptions_tweet_preview_api_enabled: true,
    communities_web_enable_tweet_community_results_fetch: true,
    c9s_tweet_anatomy_moderator_badge_enabled: true,
    articles_preview_enabled: true,
    responsive_web_edit_tweet_api_enabled: true,
    graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
    view_counts_everywhere_api_enabled: true,
    longform_notetweets_consumption_enabled: true,
    responsive_web_twitter_article_tweet_consumption_enabled: true,
    tweet_awards_web_tipping_enabled: false,
    creator_subscriptions_quote_tweet_preview_enabled: false,
    freedom_of_speech_not_reach_fetch_enabled: true,
    standardized_nudges_misinfo: true,
    tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
    rweb_video_timestamps_enabled: true,
    longform_notetweets_rich_text_read_enabled: true,
    longform_notetweets_inline_media_enabled: true,
    rweb_tipjar_consumption_enabled: true,
    responsive_web_graphql_exclude_directive_enabled: true,
    verified_phone_label_enabled: false,
    responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
    responsive_web_graphql_timeline_navigation_enabled: true,
    responsive_web_enhance_cards_enabled: false,
  }));
  
  const gqlRes = await fetch(
    `https://api.twitter.com/graphql/0hWvDhmW8YQ-S_ib3azIrw/TweetResultByRestId?variables=${variables}&features=${features}`,
    {
      headers: {
        Authorization: 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA',
        'x-guest-token': guest_token,
        'Content-Type': 'application/json',
      },
    }
  );
  if (!gqlRes.ok) throw new Error('Twitter GraphQL failed');
  const gqlData = await gqlRes.json();
  
  const tweet = gqlData?.data?.tweetResult?.result?.legacy || gqlData?.data?.tweetResult?.result?.tweet?.legacy;
  if (!tweet) throw new Error('Tweet not found or protected');
  
  const media = tweet.extended_entities?.media || tweet.entities?.media || [];
  const videoMedia = media.find(m => m.type === 'video' || m.type === 'animated_gif');
  if (!videoMedia) throw new Error('No video found in tweet');
  
  const variants = (videoMedia.video_info?.variants || [])
    .filter(v => v.content_type === 'video/mp4')
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  
  return {
    title: tweet.full_text?.slice(0, 80) || 'Twitter Video',
    thumbnail: videoMedia.media_url_https,
    duration: videoMedia.video_info?.duration_millis ? formatDuration(Math.floor(videoMedia.video_info.duration_millis / 1000)) : 'Unknown',
    formats: variants.map(v => ({
      url: v.url, ext: 'mp4', format_note: v.bitrate ? `${Math.round(v.bitrate / 1000)}kbps` : 'Best',
      hasVideo: true, hasAudio: true,
    })),
    source: 'twitter',
  };
}

async function extractSpotify(url) {
  const oembedRes = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
  if (!oembedRes.ok) throw new Error('Spotify oembed failed');
  const oembedData = await oembedRes.json();
  
  const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  const html = await pageRes.text();
  const titleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
  const descMatch  = html.match(/<meta property="og:description" content="([^"]+)"/);
  const trackTitle = titleMatch?.[1] || oembedData.title || 'Unknown';
  const artist     = descMatch?.[1]?.split('·')[0]?.trim() || '';
  
  const searchQuery = `${trackTitle} ${artist} official audio`;
  const searchRes = await fetch(
    `https://www.youtube.com/results?search_query=${encodeURIComponent(searchQuery)}`,
    { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'en-US,en;q=0.9' } }
  );
  const searchHtml = await searchRes.text();
  const videoIdMatch = searchHtml.match(/"videoId":"([a-zA-Z0-9_-]{11})"/);
  if (!videoIdMatch) throw new Error('Could not find YouTube match for Spotify track');
  
  const ytResult = await extractYouTube(videoIdMatch[1]);
  return {
    ...ytResult,
    title: `${trackTitle}${artist ? ' — ' + artist : ''}`,
    thumbnail: oembedData.thumbnail_url || ytResult.thumbnail,
    source: 'spotify-via-youtube',
    isAudioOnly: true,
  };
}

async function extractTikTok(url) {
  const resolved = await fetch(url, { redirect: 'follow' });
  const finalUrl = resolved.url;
  
  const videoIdMatch = finalUrl.match(/\/video\/(\d+)/);
  if (!videoIdMatch) throw new Error('Could not extract TikTok video ID');
  const videoId = videoIdMatch[1];
  
  const apiRes = await fetch(
    `https://api22-normal-c-alisg.tiktokv.com/aweme/v1/feed/?aweme_id=${videoId}&version_name=26.1.3&version_code=260103&build_number=26.1.3&manifest_version_code=260103&update_version_code=260103&openudid=1234567890abcdef&uuid=1234567890abcdef&_rticket=${Date.now()}&ts=${Math.floor(Date.now()/1000)}&device_brand=Google&device_type=Pixel+4&device_platform=android&resolution=1080*1920&dpi=420&os_version=10&os_api=29&carrier_region=US&sys_region=US&region=US&app_name=trill&app_language=en&language=en&timezone_name=America/New_York&timezone_offset=-18000&channel=googleplay&ac=wifi&mcc_mnc=310260&is_my_cn=0&ssmix=a&as=a1qwert123&cp=cbfhckdckkde1`,
    { headers: { 'User-Agent': 'com.zhiliaoapp.musically/2022600030 (Linux; U; Android 10; en_US; Pixel 4; Build/QQ3A.200805.001; Cronet/58.0.2991.0)' } }
  );
  if (!apiRes.ok) throw new Error('TikTok API failed');
  const apiData = await apiRes.json();
  const aweme = apiData?.aweme_list?.[0];
  if (!aweme) throw new Error('TikTok video data not found');
  
  const video = aweme.video;
  const downloadUrl = video?.download_addr?.url_list?.[0] || video?.play_addr?.url_list?.[0];
  
  return {
    title: aweme.desc || 'TikTok Video',
    thumbnail: video?.cover?.url_list?.[0] || null,
    duration: video?.duration ? formatDuration(Math.floor(video.duration / 1000)) : 'Unknown',
    formats: [{ url: downloadUrl, ext: 'mp4', format_note: 'No Watermark', hasVideo: true, hasAudio: true }],
    source: 'tiktok',
  };
}

async function extractVimeo(url) {
  const videoIdMatch = url.match(/vimeo\.com\/(\d+)/);
  if (!videoIdMatch) throw new Error('Invalid Vimeo URL');
  const videoId = videoIdMatch[1];
  
  const oembedRes = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`);
  const oembed = oembedRes.ok ? await oembedRes.json() : {};
  
  const configRes = await fetch(`https://player.vimeo.com/video/${videoId}/config`, {
    headers: { 'Referer': 'https://vimeo.com/' }
  });
  if (!configRes.ok) throw new Error('Vimeo config failed');
  const config = await configRes.json();
  
  const files = config?.request?.files?.progressive || [];
  const formats = files
    .sort((a, b) => b.height - a.height)
    .map(f => ({
      url: f.url, ext: 'mp4', format_note: `${f.height}p`, hasVideo: true, hasAudio: true,
    }));
  
  return {
    title: oembed.title || config?.video?.title || 'Vimeo Video',
    thumbnail: oembed.thumbnail_url || null,
    duration: oembed.duration ? formatDuration(oembed.duration) : 'Unknown',
    formats,
    source: 'vimeo',
  };
}

async function extractSoundCloud(url) {
  const pageRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!pageRes.ok) throw new Error('SoundCloud page fetch failed');
  const html = await pageRes.text();
  
  const scriptUrls = [...html.matchAll(/src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g)].map(m => m[1]);
  
  let clientId = null;
  for (const scriptUrl of scriptUrls.slice(-3)) {
    const scriptRes = await fetch(scriptUrl);
    const script = await scriptRes.text();
    const match = script.match(/client_id:"([a-zA-Z0-9]+)"/);
    if (match) { clientId = match[1]; break; }
  }
  if (!clientId) throw new Error('Could not extract SoundCloud client_id');
  
  const resolveRes = await fetch(
    `https://api-v2.soundcloud.com/resolve?url=${encodeURIComponent(url)}&client_id=${clientId}`
  );
  if (!resolveRes.ok) throw new Error('SoundCloud resolve failed');
  const track = await resolveRes.json();
  
  const transcodings = track.media?.transcodings || [];
  const hls = transcodings.find(t => t.format?.protocol === 'hls');
  const progressive = transcodings.find(t => t.format?.protocol === 'progressive');
  const preferred = progressive || hls;
  
  if (!preferred) throw new Error('No stream found for SoundCloud track');
  
  const streamRes = await fetch(`${preferred.url}?client_id=${clientId}`);
  const streamData = await streamRes.json();
  
  return {
    title: track.title || 'SoundCloud Track',
    thumbnail: track.artwork_url?.replace('large', 't500x500') || null,
    duration: track.duration ? formatDuration(Math.floor(track.duration / 1000)) : 'Unknown',
    formats: [{ url: streamData.url, ext: 'mp3', format_note: 'Audio (MP3)', hasVideo: false, hasAudio: true }],
    source: 'soundcloud',
    isAudioOnly: true,
  };
}

async function extractGeneric(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) {
     return {
        title: 'Media',
        thumbnail: null,
        duration: null,
        url: url,
        formats: [{ url, ext: 'mp4', format_note: 'Direct Link', hasVideo: true, hasAudio: true }],
        source: 'direct',
     };
  }
  const html = await res.text();
  
  const patterns = [
    /property="og:video(?::url)?" content="([^"]+)"/,
    /<video[^>]+src="([^"]+)"/,
    /<source[^>]+src="([^"]+\.(?:mp4|webm|m3u8|mpd)[^"]*)"/i,
    /["'](?:videoUrl|video_url|stream_url|hls_url|playbackUrl)["']\s*:\s*["']([^"']+)["']/i,
  ];
  
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const title = titleMatch?.[1]?.trim() || 'Media';
  const thumbMatch = html.match(/property="og:image" content="([^"]+)"/);
  const thumb = thumbMatch?.[1] || null;
  
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      return {
        title, thumbnail: thumb,
        formats: [{ url: match[1], ext: 'mp4', format_note: 'Video', hasVideo: true, hasAudio: true }],
        source: 'generic-scrape',
      };
    }
  }
  
  return {
    title, thumbnail: thumb,
    formats: [{ url, ext: 'mp4', format_note: 'Direct Link', hasVideo: true, hasAudio: true }],
    source: 'direct',
  };
}

// ─── Main Handler ───────────────────────────────────────────────────────────

/* OVERRIDDEN GENERIC */
async function _old_extractGeneric(url) {
  const oembedProviders = [
    { match: /twitter\.com|x\.com/i, endpoint: `https://publish.twitter.com/oembed?url=${encodeURIComponent(url)}` },
    { match: /instagram\.com/i, endpoint: `https://api.instagram.com/oembed?url=${encodeURIComponent(url)}` },
    { match: /soundcloud\.com/i, endpoint: `https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json` },
    { match: /vimeo\.com/i, endpoint: `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}` },
  ];

  for (const provider of oembedProviders) {
    if (provider.match.test(url)) {
      try {
        const res = await fetch(provider.endpoint, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        if (res.ok) {
          const data = await res.json();
          return {
            title: data.title || data.author_name || 'Media',
            thumbnail: data.thumbnail_url || null,
            duration: null,
            url: url,
            formats: [{ url, ext: 'mp4', format_note: 'Original', resolution: 'Unknown', filesize: null }],
            source: 'oembed',
          };
        }
      } catch {
        // Fall through
      }
    }
  }

  return {
    title: 'Media',
    thumbnail: null,
    duration: null,
    url: url,
    formats: [{ url, ext: 'mp4', format_note: 'Direct Link', resolution: 'Unknown', filesize: null }],
    source: 'direct',
  };
}

// ─── Main Handler ───────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    // 1. Handle Preflight (OPTIONS) requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    };

    // 2. Origin Security Check (shared by all endpoints)
    const allowedOrigins = env.ALLOWED_ORIGINS 
      ? env.ALLOWED_ORIGINS.split(',').map(o => o.trim())
      : ['http://localhost:3000', 'https://OmniConvert.vercel.app', 'http://localhost:3001'];
      // Wake Endpoint (Used to pre-warm Render YT-DLP instance on page load)
      if (url.pathname === '/wake') {
        if (env.BACKEND_API_URL) {
          // Fire-and-forget ping to backend to wake it up
          ctx.waitUntil(fetch(`${env.BACKEND_API_URL}/wake`, { 
            method: 'GET',
            headers: { "Accept": "application/json" }
          }).catch(() => {}));
        }
        return new Response(JSON.stringify({ status: "waking", message: "Ping sent to backend." }), {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

    const origin = request.headers.get('Origin');

    if (!origin || !allowedOrigins.some(ao => origin.toLowerCase() === ao.toLowerCase())) {
      console.error(`[Proxy] Unauthorized Origin: ${origin}`);
      return new Response('Unauthorized Origin: ' + origin, { status: 403 });
    }

    // ──────────────────────────────────────────────────────────────────
    // EXTRACTION ENDPOINT: POST /extract
    // ──────────────────────────────────────────────────────────────────
    if (url.pathname === '/extract' && request.method === 'POST') {
      try {
        const body = await request.json();
        const targetUrl = body.url;

        if (!targetUrl) {
          return jsonResponse({ error: 'Missing "url" in request body' }, origin, 400);
        }

        const platform = detectPlatform(targetUrl);
        let result;
        switch (platform) {
          case 'youtube':   
            const playlistId = extractPlaylistId(targetUrl);
            const videoId = extractVideoId(targetUrl);
            if (playlistId && !videoId) {
              result = await extractYouTubePlaylist(playlistId);
            } else if (videoId) {
              result = await extractYouTubeBackend(videoId, env);
            } else {
              throw new Error("Invalid YouTube URL");
            }
            break;
          case 'reddit':    result = await extractReddit(targetUrl); break;
          case 'twitter':   result = await extractTwitter(targetUrl); break;
          case 'spotify':   result = await extractSpotify(targetUrl); break;
          case 'tiktok':    result = await extractTikTok(targetUrl); break;
          case 'vimeo':     result = await extractVimeo(targetUrl); break;
          case 'soundcloud':result = await extractSoundCloud(targetUrl); break;
          default:          result = await extractGeneric(targetUrl);
        }
        result.platform = platform; // always include for UI badge
        return jsonResponse(result, origin);
      } catch (err) {
        console.error(`[Extract] Error:`, err.message);
        return jsonResponse({ error: err.message || 'Extraction failed' }, origin, 500);
      }
    }

    // ──────────────────────────────────────────────────────────────────
    // PROXY ENDPOINT: GET/POST /?url=...
    // ──────────────────────────────────────────────────────────────────
    const targetUrl = url.searchParams.get('url');

    if (!targetUrl) {
      return new Response('Missing target URL', { status: 400 });
    }

    const headers = new Headers(request.headers);
    headers.delete('Host');
    
    try {
      const targetUrlObj = new URL(targetUrl);
      headers.set('Origin', targetUrlObj.origin);
      headers.set('Referer', targetUrlObj.href);
      
      if (!headers.has('User-Agent')) {
        headers.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
      }
    } catch (e) {
      return new Response('Invalid target URL', { status: 400 });
    }

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: headers,
        redirect: 'follow',
      });

      if (response.status >= 400 && response.status !== 404) {
        console.warn(`[Proxy] Target ${targetUrl} Responded: ${response.status}`);
      }

      const newHeaders = new Headers(response.headers);
      
      const headersToStrip = [
        'Transfer-Encoding',
        'Content-Encoding',
        'Content-Length',
        'Connection',
        'Keep-Alive',
        'Proxy-Authenticate',
        'Proxy-Authorization',
        'TE',
        'Trailers',
        'Upgrade'
      ];
      
      headersToStrip.forEach(h => newHeaders.delete(h));
      
      newHeaders.set('Access-Control-Allow-Origin', origin || '*');
      newHeaders.set('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
      newHeaders.set('Access-Control-Allow-Headers', '*');
      newHeaders.set('Access-Control-Expose-Headers', '*');
      
      // CRITICAL: These headers allow the browser to use SharedArrayBuffer (Wasm Threads)
      newHeaders.set('Cross-Origin-Resource-Policy', 'cross-origin');
      newHeaders.set('Cross-Origin-Embedder-Policy', 'require-corp');

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: newHeaders,
      });
    } catch (error) {
      console.error(`[Proxy] Proxy error: ${error.message}`);
      return new Response(`Proxy error: ${error.message}`, { status: 500 });
    }
  },
};
