"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { 
  X, 
  Crop as CropIcon, 
  Scissors, 
  Monitor, 
  CloudRain, 
  Volume2, 
  Check, 
  Play, 
  Pause,
  ChevronRight,
  MousePointer2,
  Maximize2,
  Palette,
  Droplets
} from "lucide-react";
import { cn } from "@/lib/utils";
import Cropper, { Area } from "react-easy-crop";

interface EditOptions {
  trimStart?: number;
  trimEnd?: number;
  crop?: { x: number; y: number; width: number; height: number };
  resolution?: string;
  transparencyColor?: string;
  transparencySimilarity?: number;
  transparencyBlend?: number;
  audioBitrate?: string;
  frameTimestamp?: number;
}

interface MediaEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: File;
  type: 'image' | 'video' | 'audio' | 'video-to-image';
  initialOptions?: EditOptions;
  onSave: (options: EditOptions) => void;
}

export function MediaEditorModal({ isOpen, onClose, file, type, initialOptions, onSave }: MediaEditorModalProps) {
  const [options, setOptions] = useState<EditOptions>(initialOptions || {});
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Cropper State
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [isCropping, setIsCropping] = useState(false);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    if (isOpen) {
      const url = URL.createObjectURL(file);
      setPreviewUrl(url);
      
      if (type === 'image') {
        const img = new Image();
        img.onload = () => {
          setImageSize({ width: img.width, height: img.height });
        };
        img.src = url;
      }

      return () => URL.revokeObjectURL(url);
    }
  }, [isOpen, file, type]);

  const onCropComplete = useCallback((_: Area, pixelCrop: Area) => {
    setOptions(prev => ({
      ...prev,
      crop: {
        x: pixelCrop.x,
        y: pixelCrop.y,
        width: pixelCrop.width,
        height: pixelCrop.height
      }
    }));
  }, []);

  const handleSave = () => {
    onSave(options);
    onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 md:p-8">
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/80 backdrop-blur-xl"
          />
          
          <motion.div 
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            className="relative w-full max-w-6xl bg-[#1f2228] border border-white/10 rounded-[2.5rem] shadow-3xl overflow-hidden flex flex-col max-h-[90vh]"
          >
            {/* Header */}
            <div className="flex items-center justify-between p-6 border-b border-white/5 bg-black/20">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 bg-[#e11d48]/10 rounded-xl flex items-center justify-center border border-[#e11d48]/20">
                  {type === 'image' && <CropIcon className="w-5 h-5 text-[#e11d48]" />}
                  {(type === 'video' || type === 'video-to-image') && <Scissors className="w-5 h-5 text-[#e11d48]" />}
                  {type === 'audio' && <Volume2 className="w-5 h-5 text-[#e11d48]" />}
                </div>
                <div>
                  <h3 className="text-xl font-black uppercase tracking-tight italic">
                    {type === 'video-to-image' ? 'Frame Selection' : `${type.charAt(0).toUpperCase() + type.slice(1)} Editor`}
                  </h3>
                  <p className="text-[10px] font-bold text-neutral-500 uppercase tracking-widest">{file.name}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button 
                   onClick={handleSave}
                   className="px-6 py-2.5 bg-[#e11d48] hover:bg-[#be123c] rounded-xl text-xs font-black uppercase tracking-widest transition-all shadow-lg shadow-[#e11d48]/20 flex items-center gap-2"
                >
                   <Check className="w-4 h-4" /> Save Changes
                </button>
                <button onClick={onClose} className="p-2.5 hover:bg-white/5 rounded-full transition-colors"><X className="w-6 h-6" /></button>
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto flex flex-col md:flex-row">
              {/* Preview Area */}
              <div className="flex-[2] bg-[#0a0c10] flex flex-col items-center justify-center p-8 relative min-h-[400px]">
                {type === 'image' && previewUrl && (
                  <div className="relative w-full h-full flex items-center justify-center">
                    {isCropping ? (
                      <div className="w-full h-full relative bg-black/40 rounded-2xl overflow-hidden border border-white/5">
                        <Cropper
                          image={previewUrl}
                          crop={crop}
                          zoom={zoom}
                          aspect={undefined}
                          onCropChange={setCrop}
                          onCropComplete={onCropComplete}
                          onZoomChange={setZoom}
                          classes={{
                            containerClassName: "rounded-2xl",
                            mediaClassName: "rounded-2xl",
                          }}
                        />
                      </div>
                    ) : (
                      <div className="relative group">
                         <img 
                            src={previewUrl} 
                            className="max-w-full max-h-[500px] rounded-2xl shadow-2xl object-contain border border-white/5" 
                            alt="Preview" 
                         />
                         {options.crop && (
                            <div 
                               className="absolute border-2 border-[#e11d48] border-dashed pointer-events-none bg-[#e11d48]/5"
                               style={{
                                  left: `${(options.crop.x / imageSize.width) * 100}%`,
                                  top: `${(options.crop.y / imageSize.height) * 100}%`,
                                  width: `${(options.crop.width / imageSize.width) * 100}%`,
                                  height: `${(options.crop.height / imageSize.height) * 100}%`,
                               }}
                            >
                               <div className="absolute -top-6 left-0 bg-[#e11d48] text-[8px] font-black text-white px-2 py-0.5 rounded-t-md uppercase">Cropped Zone</div>
                            </div>
                         )}
                      </div>
                    )}
                  </div>
                )}
                {(type === 'video' || type === 'video-to-image') && previewUrl && (
                  <div className="w-full h-full flex flex-col gap-4">
                    <div className="relative flex-1 flex items-center justify-center">
                      <video 
                        ref={videoRef}
                        src={previewUrl} 
                        className="max-w-full max-h-full rounded-lg shadow-2xl"
                        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                      />
                      {type === 'video-to-image' && (
                         <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                            <div className="w-24 h-24 border-2 border-[#e11d48] border-dashed rounded-full flex items-center justify-center bg-[#e11d48]/10 backdrop-blur-sm animate-pulse">
                               <Check className="w-10 h-10 text-white" />
                            </div>
                         </div>
                      )}
                    </div>
                    
                    {/* Video Controls */}
                    <div className="bg-black/60 backdrop-blur-md rounded-2xl p-4 border border-white/5 flex flex-col gap-3">
                       <div className="flex items-center gap-4">
                         <button 
                           onClick={() => {
                             if (videoRef.current?.paused) {
                               videoRef.current.play();
                               setIsPlaying(true);
                             } else {
                               videoRef.current?.pause();
                               setIsPlaying(false);
                             }
                           }}
                           className="w-10 h-10 bg-[#e11d48] rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-all"
                         >
                           {isPlaying ? <Pause className="w-5 h-5 fill-white" /> : <Play className="w-5 h-5 fill-white ml-0.5" />}
                         </button>
                         <div className="flex-1 h-1.5 bg-white/10 rounded-full relative overflow-hidden group cursor-pointer" onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const x = e.clientX - rect.left;
                            const pct = x / rect.width;
                            if (videoRef.current) videoRef.current.currentTime = pct * duration;
                         }}>
                            <div className="absolute inset-y-0 left-0 bg-[#e11d48]" style={{ width: `${(currentTime/duration)*100}%` }} />
                         </div>
                         <span className="text-[10px] font-mono font-bold text-neutral-400">
                           {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
                         </span>
                       </div>
                    </div>
                  </div>
                )}
                {type === 'audio' && (
                   <div className="flex flex-col items-center gap-6">
                      <div className="w-32 h-32 bg-[#e11d48]/10 rounded-[2rem] border-2 border-[#e11d48]/20 flex items-center justify-center">
                         <Volume2 className="w-12 h-12 text-[#e11d48]" />
                      </div>
                      <p className="text-neutral-400 font-bold uppercase tracking-widest text-xs">Audio Waveform Analysis...</p>
                   </div>
                )}
              </div>

              {/* Controls Sidebar */}
              <div className="flex-1 border-l border-white/5 p-8 space-y-10 min-w-[380px] bg-[#1a1d23]">
                {type === 'image' && (
                  <>
                    <EditorSection title="Transparency Engine" icon={<Droplets className="w-4 h-4" />}>
                      <div className="space-y-6">
                         <div className="space-y-2">
                            <div className="flex items-center justify-between">
                               <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Color to Remove</label>
                               {options.transparencyColor && (
                                  <button 
                                     onClick={() => setOptions({ ...options, transparencyColor: undefined })}
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
                                    onChange={(e) => setOptions({ ...options, transparencyColor: e.target.value })}
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
                                 onChange={(e) => setOptions({ ...options, transparencyColor: e.target.value })}
                               />
                            </div>
                         </div>

                         <div className="space-y-4">
                            <div className="flex items-center justify-between">
                               <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Color Similarity</label>
                               <span className="text-[10px] font-mono font-black text-[#e11d48]">{Math.round((options.transparencySimilarity || 0.1) * 100)}%</span>
                            </div>
                            <input 
                               type="range" 
                               min="0.01" 
                               max="1.0" 
                               step="0.01"
                               className="w-full accent-[#e11d48]"
                               value={options.transparencySimilarity || 0.1}
                               onChange={(e) => setOptions({ ...options, transparencySimilarity: parseFloat(e.target.value) })}
                            />
                            <p className="text-[9px] text-neutral-500 font-medium italic">Higher values remove more colors similar to the target.</p>
                         </div>

                         <div className="space-y-4">
                            <div className="flex items-center justify-between">
                               <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">Edge Blend</label>
                               <span className="text-[10px] font-mono font-black text-[#e11d48]">{Math.round((options.transparencyBlend || 0.1) * 100)}%</span>
                            </div>
                            <input 
                               type="range" 
                               min="0.0" 
                               max="1.0" 
                               step="0.01"
                               className="w-full accent-[#e11d48]"
                               value={options.transparencyBlend || 0.1}
                               onChange={(e) => setOptions({ ...options, transparencyBlend: parseFloat(e.target.value) })}
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

                    <EditorSection title="Canvas Resolution" icon={<Monitor className="w-4 h-4" />}>
                      <select 
                        className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:border-[#e11d48] transition-colors"
                        value={options.resolution || ""}
                        onChange={(e) => setOptions({ ...options, resolution: e.target.value })}
                      >
                         <option value="">Original</option>
                         <option value="1920x1080">1080p (FHD)</option>
                         <option value="1280x720">720p (HD)</option>
                         <option value="800x600">800x600 (SVGA)</option>
                         <option value="640x480">640x480 (VGA)</option>
                      </select>
                    </EditorSection>
                  </>
                )}

                {(type === 'video' || type === 'video-to-image') && (
                  <>
                    <EditorSection title={type === 'video-to-image' ? "Target Frame" : "Time Logic"} icon={<Scissors className="w-4 h-4" />}>
                       {type === 'video-to-image' ? (
                          <div className="space-y-4">
                             <div className="p-6 bg-[#e11d48]/10 border border-[#e11d48]/20 rounded-2xl">
                                <p className="text-[10px] font-bold text-[#e11d48] uppercase tracking-widest mb-1">Selected Moment:</p>
                                <p className="text-3xl font-black italic">{currentTime.toFixed(3)}s</p>
                             </div>
                             <button 
                               onClick={() => setOptions({ ...options, frameTimestamp: currentTime })}
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
                                     onChange={(e) => setOptions({ ...options, trimStart: parseFloat(e.target.value) })}
                                   />
                                </div>
                                <div className="space-y-1.5">
                                   <label className="text-[10px] font-black uppercase tracking-widest text-neutral-500">End (s)</label>
                                   <input 
                                     type="number" 
                                     className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-xs font-bold outline-none focus:border-[#e11d48] transition-colors"
                                     value={options.trimEnd || duration}
                                     onChange={(e) => setOptions({ ...options, trimEnd: parseFloat(e.target.value) })}
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
                                   onClick={() => setOptions({ ...options, audioBitrate: br })}
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
                   <button onClick={handleSave} className="flex-[1.5] py-4 bg-[#e11d48] hover:bg-[#be123c] rounded-2xl text-[10px] font-black uppercase tracking-widest transition-all shadow-xl shadow-[#e11d48]/20 flex items-center justify-center gap-2 group">
                      Save Manifest <ChevronRight className="w-4 h-4 group-hover:translate-x-1 transition-transform" />
                   </button>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
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
