import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execPromise = promisify(exec);

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (!url) {
      return NextResponse.json({ error: "No URL provided" }, { status: 400 });
    }

    // Resolve binary dynamically
    const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const binPath = path.join(process.cwd(), 'node_modules', 'youtube-dl-exec', 'bin', binName);
    
    // Check if binary exists
    try {
      const fs = require('fs');
      if (!fs.existsSync(binPath)) {
        return NextResponse.json({ 
          error: "Local yt-dlp binary not found. Since you are using a Raspberry Pi, please ensure NEXT_PUBLIC_SCRAPER_API_URL is set correctly in your .env file to point to the Pi's IP address (e.g., http://192.168.1.100:8080/extract)." 
        }, { status: 500 });
      }
    } catch (fsErr) {
      console.error("[Local Extractor] FS check failed:", fsErr);
    }

    console.log(`[Local Extractor] Executing yt-dlp for ${url} at ${binPath}`);

    // Run yt-dlp to get JSON metadata (-J flag)
    // using 50MB maxBuffer to ensure large playlists or formats don't crash the buffer
    const { stdout } = await execPromise(`"${binPath}" -J --no-warnings --prefer-free-formats "${url}"`, { maxBuffer: 1024 * 1024 * 50 });
    
    const data = JSON.parse(stdout);

    // Format the response to match what the frontend expects
    const formats = (data.formats || []).map((f: any) => {
      const hasVideo = f.vcodec && f.vcodec !== 'none';
      const hasAudio = f.acodec && f.acodec !== 'none';
      
      let format_note = f.format_note || '';
      if (!format_note) {
        if (hasVideo && hasAudio) format_note = `${f.height}p`;
        else if (hasVideo) format_note = `${f.height}p (video only)`;
        else if (hasAudio) format_note = `audio only`;
      } else {
        if (hasVideo && !hasAudio) format_note += ' (video only)';
      }

      return {
        url: f.url,
        ext: f.ext,
        format_note,
        resolution: f.resolution || (f.width ? `${f.width}x${f.height}` : 'audio only'),
        filesize: f.filesize || f.filesize_approx || null,
        hasVideo,
        hasAudio
      };
    });

    const result = {
      title: data.title || 'Extracted Video',
      thumbnail: data.thumbnail || null,
      duration: data.duration_string || `${data.duration}s`,
      formats: formats.reverse(), // usually best formats are at the bottom of yt-dlp output
      source: 'local-ytdlp',
      platform: data.extractor || 'generic'
    };

    return NextResponse.json(result);
  } catch (err: any) {
    console.error("[Local Extractor] yt-dlp extraction failed:", err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
