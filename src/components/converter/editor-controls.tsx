"use client";

import { useRef } from "react";
import {
  Crop as CropIcon, Scissors, Monitor, Volume2, Check, Maximize2, Palette, Droplets,
  Gauge, Sparkles, Subtitles, Ruler,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { PRESETS, parseSubtitles, getFileCategory, type EditOptions, type Preset } from "@/lib/formats";
import type { EditorType } from "./media-editors";

interface EditorControlsProps {
  type: EditorType;
  fileName: string;
  targetFormat: string;
  options: EditOptions;
  setOptions: (options: EditOptions) => void;
  currentTime: number;
  duration: number;
  isCropping: boolean;
  setIsCropping: (cropping: boolean) => void;
  onApplyPreset: (preset: Preset) => void;
  onClose: () => void;
  onSave: () => void;
}

const LOSSY_TARGETS = ["JPG", "JPEG", "WEBP", "TIFF"];
const SPEEDS = [0.5, 1, 1.5, 2];

/** Right-hand control rail of the media editor: one panel per editor mode. */
export function EditorControls({
  type, fileName, targetFormat, options, setOptions, currentTime, duration,
  isCropping, setIsCropping, onApplyPreset, onClose, onSave,
}: EditorControlsProps) {
  const subtitleInput = useRef<HTMLInputElement>(null);
  const category = getFileCategory(fileName);
  const presets = PRESETS.filter((p) => p.categories.includes(category));
  const showQuality = type !== "audio" && (!targetFormat || LOSSY_TARGETS.includes(targetFormat.toUpperCase()));

  const patch = (next: Partial<EditOptions>) => setOptions({ ...options, ...next });

  const loadSubtitles = async (file: File) => {
    const cues = parseSubtitles(await file.text());
    if (cues.length === 0) return;
    patch({ subtitles: cues, subtitleName: file.name });
  };

  return (
    <div className="flex-1 border-l border-white/5 p-8 space-y-10 min-w-[380px] bg-[#1a1d23]">
      {presets.length > 0 && (
        <EditorSection title="Presets" icon={<Sparkles className="w-4 h-4" />}>
          <div className="grid grid-cols-2 gap-2">
            {presets.map((preset) => (
              <button
                key={preset.id}
                onClick={() => onApplyPreset(preset)}
                title={preset.hint}
                className="px-3 py-3 rounded-xl border border-white/10 bg-black/40 hover:bg-white/10 hover:border-white/20 transition-all text-left group"
              >
                <p className="text-[10px] font-black uppercase tracking-widest text-white group-hover:text-[#e11d48] transition-colors">{preset.label}</p>
                <p className="text-[8px] font-bold text-neutral-500 uppercase tracking-tight mt-1 truncate">{preset.hint}</p>
              </button>
            ))}
          </div>
        </EditorSection>
      )}

      {type === 'image' && (
        <>
          <EditorSection title="Transparency Engine" icon={<Droplets className="w-4 h-4" />}>
            <div className="space-y-6">
               <div className="space-y-2">
                  <div className="flex items-center justify-between">
                     <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Color to Remove</label>
                     {options.transparencyColor && (
                        <button
                           onClick={() => patch({ transparencyColor: undefined })}
                           className="text-[8px] font-black text-[#e11d48] uppercase hover:underline"
                        >
                           Reset
                        </button>
                     )}
                  </div>
                  <div className="flex items-center gap-3">
                     <div className="relative">
                        <input
                          type="color"
                          className="w-12 h-12 rounded-xl bg-transparent border-none cursor-pointer outline-none"
                          value={options.transparencyColor || "#000000"}
                          onChange={(e) => patch({ transparencyColor: e.target.value })}
                        />
                        {!options.transparencyColor && (
                           <div className="absolute inset-0 bg-[#1f2228] border border-white/10 rounded-xl flex items-center justify-center pointer-events-none">
                              <Palette className="w-5 h-5 text-neutral-600" />
                           </div>
                        )}
                     </div>
                     <input
                       type="text"
                       placeholder="HEX (e.g. #FFFFFF)"
                       className="flex-1 bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:border-[#e11d48] transition-colors uppercase"
                       value={options.transparencyColor || ""}
                       onChange={(e) => patch({ transparencyColor: e.target.value })}
                     />
                  </div>
               </div>

               <div className="space-y-4">
                  <div className="flex items-center justify-between">
                     <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Color Similarity</label>
                     <span className="text-[10px] font-mono font-black text-[#e11d48]">{Math.round((options.transparencySimilarity || 0.1) * 100)}%</span>
                  </div>
                  <input
                     type="range" min="0.01" max="1.0" step="0.01"
                     className="w-full accent-[#e11d48]"
                     value={options.transparencySimilarity || 0.1}
                     onChange={(e) => patch({ transparencySimilarity: parseFloat(e.target.value) })}
                  />
                  <p className="text-[9px] text-neutral-500 font-medium italic">Higher values remove more colors similar to the target.</p>
               </div>

               <div className="space-y-4">
                  <div className="flex items-center justify-between">
                     <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Edge Blend</label>
                     <span className="text-[10px] font-mono font-black text-[#e11d48]">{Math.round((options.transparencyBlend || 0.1) * 100)}%</span>
                  </div>
                  <input
                     type="range" min="0.0" max="1.0" step="0.01"
                     className="w-full accent-[#e11d48]"
                     value={options.transparencyBlend || 0.1}
                     onChange={(e) => patch({ transparencyBlend: parseFloat(e.target.value) })}
                  />
               </div>
            </div>
          </EditorSection>

          <EditorSection title="Visual Cropper" icon={<CropIcon className="w-4 h-4" />}>
             <div className="space-y-4">
                <button
                   onClick={() => setIsCropping(!isCropping)}
                   className={cn(
                      "w-full py-4 border rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all flex items-center justify-center gap-3",
                      isCropping
                         ? "bg-[#e11d48] border-[#e11d48] text-white shadow-xl shadow-[#e11d48]/20"
                         : "bg-white/5 border-white/10 text-neutral-400 hover:bg-white/10 hover:border-white/20"
                   )}
                >
                   {isCropping ? <><Check className="w-4 h-4" /> Confirm Crop Area</> : <><Maximize2 className="w-4 h-4" /> Enter Crop Mode</>}
                </button>

                {options.crop && !isCropping && (
                   <div className="grid grid-cols-2 gap-2">
                      <div className="p-3 bg-black/40 rounded-xl border border-white/5">
                         <p className="text-[8px] font-black text-neutral-500 uppercase mb-1">Position</p>
                         <p className="text-[10px] font-mono font-bold text-white">{options.crop.x}, {options.crop.y}</p>
                      </div>
                      <div className="p-3 bg-black/40 rounded-xl border border-white/5">
                         <p className="text-[8px] font-black text-neutral-500 uppercase mb-1">Dimensions</p>
                         <p className="text-[10px] font-mono font-bold text-white">{options.crop.width} x {options.crop.height}</p>
                      </div>
                   </div>
                )}
             </div>
          </EditorSection>
        </>
      )}

      {type !== 'audio' && (
        <EditorSection title="Canvas Resolution" icon={<Monitor className="w-4 h-4" />}>
          <div className="space-y-5">
            <select
              className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:border-[#e11d48] transition-colors"
              value={options.resolution || ""}
              onChange={(e) => patch({ resolution: e.target.value || undefined })}
            >
               <option value="">Original</option>
               <option value="3840x2160">2160p (4K)</option>
               <option value="1920x1080">1080p (FHD)</option>
               <option value="1280x720">720p (HD)</option>
               <option value="854x480">480p (SD)</option>
               <option value="800x600">800x600 (SVGA)</option>
               <option value="640x480">640x480 (VGA)</option>
            </select>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500 flex items-center gap-2">
                  <Ruler className="w-3 h-3" /> Scale
                </label>
                <span className="text-[10px] font-mono font-black text-[#e11d48]">{options.scalePercent ?? 100}%</span>
              </div>
              <input
                type="range" min="10" max="200" step="5"
                className="w-full accent-[#e11d48] disabled:opacity-30"
                disabled={!!options.resolution}
                value={options.scalePercent ?? 100}
                onChange={(e) => patch({ scalePercent: parseInt(e.target.value, 10) })}
              />
              <p className="text-[9px] text-neutral-500 font-medium italic">
                {options.resolution ? "Clear the resolution preset to scale by percentage." : "Resizes relative to the source dimensions."}
              </p>
            </div>
          </div>
        </EditorSection>
      )}

      {showQuality && (
        <EditorSection title="Encoder Quality" icon={<Gauge className="w-4 h-4" />}>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Quality</label>
              <span className="text-[10px] font-mono font-black text-[#e11d48]">{options.quality ?? 92}</span>
            </div>
            <input
              type="range" min="20" max="100" step="1"
              className="w-full accent-[#e11d48]"
              value={options.quality ?? 92}
              onChange={(e) => patch({ quality: parseInt(e.target.value, 10) })}
            />
            <label className="flex items-center gap-3 cursor-pointer group">
              <input
                type="checkbox"
                className="w-4 h-4 accent-[#e11d48]"
                checked={!!options.preserveMetadata}
                onChange={(e) => patch({ preserveMetadata: e.target.checked || undefined })}
              />
              <span className="text-[10px] font-black uppercase tracking-widest text-neutral-400 group-hover:text-white transition-colors">
                Preserve metadata (EXIF)
              </span>
            </label>
            <p className="text-[9px] text-neutral-500 font-medium italic">
              Stripping metadata removes camera, location and timestamp tags.
            </p>
          </div>
        </EditorSection>
      )}

      {(type === 'video' || type === 'video-to-image' || type === 'audio') && (
        <EditorSection title={type === 'video-to-image' ? "Target Frame" : "Time Logic"} icon={<Scissors className="w-4 h-4" />}>
           {type === 'video-to-image' ? (
              <div className="space-y-4">
                 <div className="p-6 bg-[#e11d48]/10 border border-[#e11d48]/20 rounded-2xl">
                    <p className="text-[10px] font-bold text-[#e11d48] uppercase tracking-widest mb-1">Selected Moment:</p>
                    <p className="text-3xl font-black italic">{currentTime.toFixed(3)}s</p>
                 </div>
                 <button
                   onClick={() => patch({ frameTimestamp: currentTime })}
                   className="w-full py-4 bg-white/5 border border-white/10 rounded-2xl text-xs font-black uppercase tracking-widest hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
                 >
                    <Check className="w-4 h-4" /> Lock Frame
                 </button>
              </div>
           ) : (
              <div className="space-y-6">
                 <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                       <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Start (s)</label>
                       <input
                         type="number"
                         className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:border-[#e11d48] transition-colors"
                         value={options.trimStart || 0}
                         onChange={(e) => patch({ trimStart: parseFloat(e.target.value) })}
                       />
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">End (s)</label>
                       <input
                         type="number"
                         className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:border-[#e11d48] transition-colors"
                         value={options.trimEnd || duration}
                         onChange={(e) => patch({ trimEnd: parseFloat(e.target.value) })}
                       />
                    </div>
                 </div>
                 <div className="p-4 bg-white/5 rounded-2xl border border-white/5 flex items-center justify-between">
                    <p className="text-[10px] font-bold text-neutral-500 uppercase">Duration</p>
                    <p className="text-sm font-black text-[#e11d48]">
                       {((options.trimEnd || duration) - (options.trimStart || 0)).toFixed(2)}s
                    </p>
                 </div>
              </div>
           )}
        </EditorSection>
      )}

      {type === 'video' && (
        <>
          <EditorSection title="Motion" icon={<Gauge className="w-4 h-4" />}>
            <div className="space-y-6">
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Frame Rate</label>
                <select
                  className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:border-[#e11d48] transition-colors"
                  value={options.fps || ""}
                  onChange={(e) => patch({ fps: e.target.value ? Number(e.target.value) : undefined })}
                >
                  <option value="">Original</option>
                  <option value="60">60 fps</option>
                  <option value="30">30 fps</option>
                  <option value="24">24 fps</option>
                  <option value="15">15 fps</option>
                  <option value="10">10 fps</option>
                </select>
              </div>
              <div className="space-y-2">
                <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Playback Speed</label>
                <div className="grid grid-cols-4 gap-2">
                  {SPEEDS.map((speed) => (
                    <button
                      key={speed}
                      onClick={() => patch({ speed: speed === 1 ? undefined : speed })}
                      className={cn(
                        "py-3 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all",
                        (options.speed ?? 1) === speed
                          ? "bg-[#e11d48] border-[#e11d48] text-white shadow-lg shadow-[#e11d48]/20"
                          : "bg-black/40 border-white/10 text-neutral-500 hover:border-white/20"
                      )}
                    >
                      {speed}x
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </EditorSection>

          <EditorSection title="Output Size" icon={<Ruler className="w-4 h-4" />}>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Target Size</label>
                <span className="text-[10px] font-mono font-black text-[#e11d48]">
                  {options.targetSizeMB ? `${options.targetSizeMB} MB` : "Off"}
                </span>
              </div>
              <input
                type="range" min="0" max="100" step="1"
                className="w-full accent-[#e11d48]"
                value={options.targetSizeMB ?? 0}
                onChange={(e) => {
                  const value = parseInt(e.target.value, 10);
                  patch({ targetSizeMB: value === 0 ? undefined : value });
                }}
              />
              <p className="text-[9px] text-neutral-500 font-medium italic">
                The bitrate is calculated from the clip duration so the file lands near this size.
              </p>
            </div>
          </EditorSection>

          <EditorSection title="Subtitles" icon={<Subtitles className="w-4 h-4" />}>
            <div className="space-y-3">
              <input
                ref={subtitleInput}
                type="file"
                accept=".srt,.vtt,text/plain"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) loadSubtitles(f); e.target.value = ""; }}
              />
              <button
                onClick={() => subtitleInput.current?.click()}
                className="w-full py-4 bg-white/5 border border-white/10 rounded-2xl text-[10px] font-black uppercase tracking-widest hover:bg-white/10 transition-colors flex items-center justify-center gap-2"
              >
                <Subtitles className="w-4 h-4" /> {options.subtitles?.length ? "Replace .srt / .vtt" : "Burn in .srt / .vtt"}
              </button>
              {options.subtitles?.length ? (
                <div className="p-3 bg-black/40 rounded-xl border border-white/5 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[10px] font-bold text-white truncate">{options.subtitleName}</p>
                    <p className="text-[8px] font-black uppercase tracking-widest text-neutral-500">{options.subtitles.length} cues</p>
                  </div>
                  <button
                    onClick={() => patch({ subtitles: undefined, subtitleName: undefined })}
                    className="text-[8px] font-black text-[#e11d48] uppercase hover:underline shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <p className="text-[9px] text-neutral-500 font-medium italic">
                  Cues are drawn onto the frames during encoding.
                </p>
              )}
            </div>
          </EditorSection>
        </>
      )}

      {type === 'audio' && (
        <EditorSection title="Acoustic Fidelity" icon={<Volume2 className="w-4 h-4" />}>
           <div className="space-y-4">
              <div className="space-y-1.5">
                 <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Bitrate (Audio Quality)</label>
                 <div className="grid grid-cols-2 gap-2">
                    {['128k', '192k', '256k', '320k'].map((br) => (
                       <button
                         key={br}
                         onClick={() => patch({ audioBitrate: br })}
                         className={cn(
                           "py-3 rounded-xl text-[10px] font-black uppercase tracking-widest border transition-all",
                           options.audioBitrate === br ? "bg-[#e11d48] border-[#e11d48] text-white shadow-lg shadow-[#e11d48]/20" : "bg-black/40 border-white/10 text-neutral-500 hover:border-white/20"
                         )}
                       >
                          {br}
                       </button>
                    ))}
                 </div>
              </div>
           </div>
        </EditorSection>
      )}

       <div className="pt-8 border-t border-white/5 flex gap-3">
          <button onClick={onClose} className="flex-1 py-4 bg-white/5 hover:bg-white/10 border border-white/10 rounded-2xl text-[10px] font-black uppercase tracking-widest transition-colors">Discard</button>
          <button onClick={onSave} className="flex-[1.5] py-4 bg-[#e11d48] hover:bg-[#be123c] rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-xl shadow-[#e11d48]/20 flex items-center justify-center gap-2 group">
             Save <Check className="w-4 h-4" />
          </button>
       </div>
    </div>
  );
}

function EditorSection({ title, icon, children }: { title: string, icon: React.ReactNode, children: React.ReactNode }) {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-[#e11d48]">
        <div className="p-2 bg-[#e11d48]/10 rounded-lg">
          {icon}
        </div>
        <h4 className="text-[12px] font-black uppercase tracking-[0.2em]">{title}</h4>
      </div>
      <div className="pl-1">
        {children}
      </div>
    </div>
  );
}
