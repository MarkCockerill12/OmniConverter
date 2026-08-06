import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFilePromise = promisify(execFile);

/**
 * Local yt-dlp fallback used when NEXT_PUBLIC_SCRAPER_API_URL does not point at
 * the Pi backend. The binary is resolved from YT_DLP_PATH or the system PATH,
 * so no multi-hundred-megabyte npm dependency is needed.
 */
const YT_DLP_BIN = process.env.YT_DLP_PATH || (process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

export async function POST(req: Request) {
  try {
    const { url } = await req.json();
    if (!url || typeof url !== 'string') {
      return NextResponse.json({ error: "No URL provided" }, { status: 400 });
    }

    // Only ever hand a well-formed http(s) URL to the extractor.
    let parsed: URL;
    try {
      parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('bad protocol');
    } catch {
      return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
    }

    // execFile (no shell) keeps URL contents from ever being interpreted as a command.
    const { stdout } = await execFilePromise(
      YT_DLP_BIN,
      ['-J', '--no-warnings', '--prefer-free-formats', parsed.toString()],
      { maxBuffer: 1024 * 1024 * 50, timeout: 120_000 }
    );

    const data = JSON.parse(stdout);

    const formats = (data.formats || []).map((f: any) => {
      const hasVideo = f.vcodec && f.vcodec !== 'none';
      const hasAudio = f.acodec && f.acodec !== 'none';

      let format_note = f.format_note || '';
      if (!format_note) {
        if (hasVideo && hasAudio) format_note = `${f.height}p`;
        else if (hasVideo) format_note = `${f.height}p (video only)`;
        else if (hasAudio) format_note = `audio only`;
      } else if (hasVideo && !hasAudio) {
        format_note += ' (video only)';
      }

      return {
        url: f.url,
        ext: f.ext,
        format_note,
        resolution: f.resolution || (f.width ? `${f.width}x${f.height}` : 'audio only'),
        filesize: f.filesize || f.filesize_approx || null,
        height: f.height || 0,
        hasVideo,
        hasAudio,
      };
    });

    return NextResponse.json({
      title: data.title || 'Extracted Video',
      thumbnail: data.thumbnail || null,
      duration: data.duration_string || `${data.duration}s`,
      formats: formats.reverse(), // yt-dlp lists the best formats last
      source: 'local-ytdlp',
      platform: data.extractor || 'generic',
    });
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return NextResponse.json({
        error: "yt-dlp was not found on this machine. Point NEXT_PUBLIC_SCRAPER_API_URL at your Pi scraper, or install yt-dlp and set YT_DLP_PATH.",
      }, { status: 500 });
    }
    console.error("[Local Extractor] yt-dlp extraction failed:", err?.message);
    return NextResponse.json({ error: err?.message || 'Extraction failed' }, { status: 500 });
  }
}
