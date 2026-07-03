"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useWorkers } from "@/hooks/use-workers";
import { useStore } from "@/lib/store";
import { 
  DownloadCloud, 
  Link as LinkIcon, 
  Zap, 
  Search, 
  Music, 
  Video, 
  Globe,
  Loader2,
  AlertCircle,
  Download
} from "lucide-react";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/converter/format-selector";
import { PasswordGate } from "@/components/downloader/password-gate";

const PLATFORM_MAP: Record<string, { label: string, color: string, icon: string }> = {
  youtube:    { label: 'YouTube',    color: '#FF0000', icon: '▶' },
  spotify:    { label: 'Spotify',    color: '#1DB954', icon: '♪' },
  twitter:    { label: 'Twitter/X',  color: '#1DA1F2', icon: '𝕏' },
  reddit:     { label: 'Reddit',     color: '#FF4500', icon: '◉' },
  tiktok:     { label: 'TikTok',     color: '#69C9D0', icon: '♫' },
  instagram:  { label: 'Instagram',  color: '#E1306C', icon: '◈' },
  vimeo:      { label: 'Vimeo',      color: '#1AB7EA', icon: '▷' },
  soundcloud: { label: 'SoundCloud', color: '#FF5500', icon: '☁' },
  generic:    { label: 'Web Video',  color: '#6366F1', icon: '🌐' },
};

function detectPlatformFrontend(url: string) {
  try {
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
  } catch {
    return 'generic';
  }
}

export default function DownloaderPage() {
  const { scraperWorker } = useWorkers();
  const { isScraperReady } = useStore();
  const [isAuthorized, setIsAuthorized] = useState(false);
  const [url, setUrl] = useState("");
  const [isScraping, setIsScraping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<any>(null);
  const [isAudioOnly, setIsAudioOnly] = useState(false);

  
  const [downloadState, setDownloadState] = useState({ active: false, progress: 0, filename: '' });
  const platform = detectPlatformFrontend(url);
  const pData = PLATFORM_MAP[platform] || PLATFORM_MAP.generic;

  useEffect(() => {
    if (result && result.isAudioOnly) {
      setIsAudioOnly(true);
    }
  }, [result]);

  // Pre-warm the Pi Scraper backend on page load if needed
  useEffect(() => {
    const proxyUrl = process.env.NEXT_PUBLIC_SCRAPER_API_URL || '/api/extract';
    console.log('[Downloader] 🚀 Checking Pi Scraper status...');
    // We can still keep a wake-up call for the Pi Go app if it's on a different port,
    // but the local Next.js API route (/api/extract) doesn't need "waking up".
    if (proxyUrl.startsWith('http')) {
      const wakeUrl = proxyUrl.replace('/extract', '/wake');
      fetch(wakeUrl, { method: 'GET' })
        .then(res => {
          if (res.ok) console.log('[Downloader] ✅ Pi Scraper is Ready!');
        })
        .catch(err => {
          console.warn('[Downloader] ⚠️ Pi Scraper wake ping failed:', err);
        });
    }
  }, []);

  const handleScrape = async () => {
    if (!url || !scraperWorker) return;
    setIsScraping(true);
    setError(null);
    setResult(null);

    const handler = (e: MessageEvent) => {
      const { type, result: res, error: err } = e.data;
      if (type === 'SCRAPE_SUCCESS') {
        setResult(res);
        setIsScraping(false);
        scraperWorker.removeEventListener('message', handler);
      } else if (type === 'SCRAPE_ERROR') {
        setError(err || "Failed to analyze URL.");
        setIsScraping(false);
        scraperWorker.removeEventListener('message', handler);
      }
    };

    scraperWorker.addEventListener('message', handler);
    const scraperApiUrl = process.env.NEXT_PUBLIC_SCRAPER_API_URL || '/api/extract';
    scraperWorker.postMessage({ 
      type: 'SCRAPE', 
      payload: { 
        url,
        proxyUrl: scraperApiUrl
      } 
    });
  };

  const handleDownloadPlaylistVideo = (videoUrl: string) => {
    setUrl(videoUrl);
    setTimeout(() => {
      const btn = document.getElementById('analyze-btn');
      if(btn) btn.click();
    }, 100);
  };

  const handleDownload = async (downloadUrl: string, filename: string) => {
    try {
      setDownloadState({ active: true, progress: 0, filename });
      
      // Use local proxy to bypass CORS
      const proxyUrl = `/api/proxy?url=${encodeURIComponent(downloadUrl)}`;
      const res = await fetch(proxyUrl);
      const total = parseInt(res.headers.get('content-length') || '0', 10);
      const reader = res.body!.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total) setDownloadState(s => ({ ...s, progress: Math.round((received / total) * 100) }));
      }
      const blob = new Blob(chunks as any);
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement('a'); 
      a.href = objUrl; 
      a.download = filename;
      document.body.appendChild(a);
      a.click(); 
      document.body.removeChild(a);
      URL.revokeObjectURL(objUrl);
    } catch (err) {
      console.error("Download failed:", err);
      alert("Download failed. See console for details.");
    } finally {
      setDownloadState({ active: false, progress: 100, filename: '' });
    }
  };

  if (!isAuthorized) {
    return <PasswordGate onAuthorized={() => setIsAuthorized(true)} />;
  }

  return (
    <main className="max-w-[1200px] mx-auto px-6 py-12">
      <section className="text-center mb-16">
        <h1 className="text-5xl md:text-7xl font-black tracking-tighter mb-6 leading-none uppercase italic">
          Media <span className="text-[#e11d48]">Downloader.</span>
        </h1>
        <p className="text-lg text-neutral-400 max-w-2xl mx-auto">
          Paste a link to scrape and download media from any platform. 
          <span className="text-white font-bold block mt-2 tracking-widest uppercase text-xs">Youtube • Spotify • Twitter • Instagram</span>
        </p>
      </section>

      <section className="max-w-4xl mx-auto">
        <div className="bg-[#1f2228] rounded-[2.5rem] border border-white/10 shadow-2xl p-8 md:p-12">
          
          {/* Badge */}
          <div className="mb-4 flex items-center justify-end">
             <AnimatePresence>
               {url && (
                 <motion.div 
                   initial={{ opacity: 0, scale: 0.9 }}
                   animate={{ opacity: 1, scale: 1 }}
                   exit={{ opacity: 0, scale: 0.9 }}
                   className="flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider text-white border"
                   style={{ borderColor: pData.color, backgroundColor: `${pData.color}20` }}
                 >
                   <span style={{ color: pData.color }}>{pData.icon}</span> {pData.label}
                 </motion.div>
               )}
             </AnimatePresence>
          </div>

          <div className="relative mb-8 group">
            <div className="absolute left-6 top-1/2 -translate-y-1/2">
              {isScraping ? (
                <Loader2 className="w-6 h-6 text-[#e11d48] animate-spin" />
              ) : (
                <LinkIcon className="w-6 h-6 text-neutral-500 group-focus-within:text-[#e11d48] transition-colors" />
              )}
            </div>
            <input 
              type="text" 
              placeholder="Paste URL here (e.g. https://youtube.com/watch?v=...)"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              className="w-full h-20 pl-16 pr-40 bg-black/20 border border-white/5 rounded-2xl focus:outline-none focus:ring-4 focus:ring-[#e11d48]/10 focus:border-[#e11d48] transition-all text-xl font-medium"
            />
            <button 
              id="analyze-btn"
              onClick={handleScrape}
              disabled={!url || isScraping}
              className="absolute right-3 top-3 bottom-3 px-8 bg-[#e11d48] hover:bg-[#be123c] rounded-xl font-black uppercase tracking-widest text-sm disabled:opacity-50 transition-all flex items-center gap-2"
            >
              Analyze <Zap className="w-4 h-4 fill-white" />
            </button>
          </div>

          <div className="flex items-center justify-end mb-12">
            {/* Audio Toggle */}
            <div className="flex items-center gap-3">
              <span className="text-xs font-bold uppercase tracking-wider text-neutral-400">Audio Only</span>
              <button 
                onClick={() => setIsAudioOnly(!isAudioOnly)}
                className={cn(
                  "w-12 h-6 rounded-full transition-colors relative",
                  isAudioOnly ? "bg-[#e11d48]" : "bg-white/10"
                )}
              >
                <div className={cn(
                  "w-5 h-5 bg-white rounded-full absolute top-0.5 transition-transform",
                  isAudioOnly ? "translate-x-6.5 left-0.5" : "translate-x-0.5"
                )} />
              </button>
            </div>
          </div>

          {/* Download Progress */}
          <AnimatePresence>
             {downloadState.active && (
               <motion.div 
                 initial={{ opacity: 0, height: 0 }}
                 animate={{ opacity: 1, height: 'auto' }}
                 exit={{ opacity: 0, height: 0 }}
                 className="mb-8 overflow-hidden"
               >
                 <div className="bg-white/5 border border-white/10 rounded-xl p-4">
                   <div className="flex items-center justify-between text-xs font-bold uppercase tracking-wider mb-2">
                     <span className="text-neutral-300">Downloading {downloadState.filename}</span>
                     <span className="text-[#e11d48]">{downloadState.progress}%</span>
                   </div>
                   <div className="w-full bg-black/40 h-2 rounded-full overflow-hidden">
                     <div 
                       className="bg-[#e11d48] h-full transition-all duration-300"
                       style={{ width: `${downloadState.progress}%` }}
                     />
                   </div>
                 </div>
               </motion.div>
             )}
          </AnimatePresence>

          <AnimatePresence mode="wait">
            {error && (
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="p-6 bg-red-500/10 border border-red-500/20 rounded-2xl flex items-center gap-4 text-red-400 mb-8"
              >
                <AlertCircle className="w-6 h-6 shrink-0" />
                <p className="font-bold">{error}</p>
              </motion.div>
            )}

            {result && (
              <motion.div 
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                className="p-8 bg-black/20 rounded-3xl border border-white/5"
              >
                {result.isPlaylist ? (
                  <div className="flex flex-col gap-6">
                    <div className="flex items-center gap-4 border-b border-white/10 pb-6">
                      <div className="w-16 h-16 rounded-xl bg-neutral-800 overflow-hidden shrink-0">
                        {result.thumbnail && <img src={result.thumbnail} className="w-full h-full object-cover" />}
                      </div>
                      <div>
                        <h3 className="text-2xl font-black tracking-tight uppercase italic line-clamp-1">{result.title}</h3>
                        <p className="text-[#e11d48] font-bold text-sm">{result.videos.length} Videos</p>
                      </div>
                    </div>
                    
                    <div className="max-h-[400px] overflow-y-auto pr-2 space-y-3 custom-scrollbar">
                      {result.videos.map((vid: any, idx: number) => (
                        <div key={idx} className="flex gap-4 p-3 bg-white/5 hover:bg-white/10 transition-colors rounded-xl border border-white/5 items-center">
                          <img src={vid.thumbnail} className="w-24 aspect-video object-cover rounded-lg" />
                          <div className="flex-1">
                            <h4 className="font-bold line-clamp-1 text-sm">{vid.title}</h4>
                            <p className="text-xs text-neutral-500 font-medium mt-1">{vid.duration}</p>
                          </div>
                          <button 
                            onClick={() => handleDownloadPlaylistVideo(vid.url)}
                            className="p-3 bg-[#e11d48] rounded-xl flex items-center justify-center hover:bg-[#be123c] shrink-0 transition-transform hover:scale-105 active:scale-95"
                          >
                            <Download className="w-4 h-4 text-white" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="flex flex-col md:flex-row gap-8 items-start">
                    <div className="w-full md:w-64 aspect-video rounded-xl bg-neutral-800 overflow-hidden relative border border-white/10 shrink-0">
                      {result.thumbnail ? (
                        <img src={result.thumbnail} className="w-full h-full object-cover opacity-80" alt="" />
                      ) : (
                        <div className="w-full h-full flex items-center justify-center">
                          <Music className="w-12 h-12 text-neutral-600" />
                        </div>
                      )}
                      <div className="absolute inset-0 flex items-center justify-center">
                        <div className="w-12 h-12 bg-[#e11d48] rounded-full flex items-center justify-center shadow-xl">
                          {isAudioOnly ? <Music className="w-6 h-6 text-white fill-white" /> : <Video className="w-6 h-6 text-white fill-white" />}
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex-1 w-full">
                      <h3 className="text-xl font-black tracking-tight mb-2 uppercase italic line-clamp-2">{result.title}</h3>
                      <p className="text-neutral-500 font-bold mb-6 tracking-widest text-xs uppercase">Duration: {result.duration}</p>
                      
                      {result.audioUrl && !isAudioOnly && (
                         <div className="mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-xs text-blue-400 flex items-start gap-2">
                           <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                           <p>This video separates audio and video streams. Download both and use the Converter tab to merge them, or switch to Audio Only.</p>
                         </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {result.formats
                          .filter((fmt: any) => {
                            if (isAudioOnly) return fmt.hasAudio && !fmt.hasVideo;
                            return true;
                          })
                          .map((fmt: any, i: number) => {
                            const isSeparateVideo = fmt.hasVideo && !fmt.hasAudio && result.audioUrl;
                            
                            return (
                              <button 
                                key={fmt.url + i} 
                                onClick={() => {
                                  const ext = fmt.ext || (isAudioOnly ? 'mp3' : 'mp4');
                                  handleDownload(fmt.url, `${result.title.slice(0, 30).replace(/[^a-z0-9]/gi, '_').toLowerCase()}.${ext}`);
                                }}
                                className="p-4 bg-white/5 hover:bg-[#e11d48] rounded-xl border border-white/5 transition-all text-left group flex items-center justify-between"
                              >
                                <div>
                                  <p className="text-[10px] font-black uppercase tracking-[0.2em] text-neutral-500 group-hover:text-white/70 mb-1">
                                    {isAudioOnly ? 'Audio Format' : 'Video Format'}
                                  </p>
                                  <p className="font-bold group-hover:text-white text-sm">
                                    {fmt.format_note || fmt.ext || 'Download'}
                                  </p>
                                  {isSeparateVideo && <p className="text-[10px] text-yellow-500 mt-1">Video Only (No Audio)</p>}
                                </div>
                                <Download className="w-4 h-4 text-neutral-400 group-hover:text-white" />
                              </button>
                            );
                        })}
                        {isAudioOnly && result.formats.filter((f: any) => f.hasAudio && !f.hasVideo).length === 0 && (
                          <div className="col-span-2 text-center p-4 border border-white/5 border-dashed rounded-xl text-neutral-500 text-sm">
                            No dedicated audio formats found.
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      <section className="mt-32 grid grid-cols-2 md:grid-cols-4 gap-4 opacity-50 grayscale hover:opacity-100 transition-opacity">
        <PlatformIcon name="YouTube" icon="▶" color="#FF0000" />
        <PlatformIcon name="Spotify" icon="♪" color="#1DB954" />
        <PlatformIcon name="Twitter" icon="𝕏" color="#1DA1F2" />
        <PlatformIcon name="TikTok" icon="♫" color="#69C9D0" />
      </section>
    </main>
  );
}

function PlatformIcon({ name, icon, color }: { name: string, icon: string, color: string }) {
  return (
    <div className="p-6 bg-white/5 rounded-2xl border border-white/5 flex flex-col items-center justify-center gap-3 hover:border-white/20 transition-colors">
      <div className="w-12 h-12 bg-neutral-800 rounded-xl flex items-center justify-center text-xl" style={{ color }}>
        {icon}
      </div>
      <span className="text-[10px] font-black uppercase tracking-widest">{name}</span>
    </div>
  );
}
