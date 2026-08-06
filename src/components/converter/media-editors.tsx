"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, Crop as CropIcon, Scissors, Volume2, Check, Play, Pause } from "lucide-react";
import { EditorControls } from "./editor-controls";
import { cn } from "@/lib/utils";
import type { EditOptions, Preset } from "@/lib/formats";
import Cropper, { Area } from "react-easy-crop";

export type EditorType = 'image' | 'video' | 'audio' | 'video-to-image';

interface MediaEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  file: File;
  type: EditorType;
  targetFormat?: string;
  initialOptions?: EditOptions;
  onSave: (options: EditOptions, targetFormat?: string) => void;
}

export function MediaEditorModal({ isOpen, onClose, file, type, targetFormat = "", initialOptions, onSave }: MediaEditorModalProps) {
  const [options, setOptions] = useState<EditOptions>(initialOptions || {});
  const [target, setTarget] = useState(targetFormat);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
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

  useEffect(() => {
    if (!isOpen) {
      if (videoRef.current) videoRef.current.pause();
      if (audioRef.current) audioRef.current.pause();
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
    }
  }, [isOpen]);

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
    onSave(options, target !== targetFormat ? target : undefined);
    onClose();
  };

  // Presets set both the encoder options and the output format in one click.
  const applyPreset = (preset: Preset) => {
    setOptions((prev) => ({ ...prev, ...preset.options }));
    setTarget(preset.target);
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
                {type === 'audio' && previewUrl && (
                  <div className="w-full h-full flex flex-col gap-6 items-center justify-center p-6">
                    <div className={cn(
                      "w-32 h-32 bg-[#e11d48]/10 rounded-[2rem] border border-[#e11d48]/20 flex items-center justify-center shadow-lg shadow-[#e11d48]/10 transition-all",
                      isPlaying && "animate-pulse scale-105 shadow-[#e11d48]/20"
                    )}>
                      <Volume2 className="w-12 h-12 text-[#e11d48]" />
                    </div>
                    
                    <audio 
                      ref={audioRef}
                      src={previewUrl}
                      onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                      onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
                    />

                    {/* Audio Controls */}
                    <div className="w-full max-w-lg bg-black/60 backdrop-blur-md rounded-2xl p-4 border border-white/5 flex flex-col gap-3">
                       <div className="flex items-center gap-4">
                         <button 
                           onClick={() => {
                             const el = audioRef.current;
                             if (el?.paused) {
                               el.play();
                               setIsPlaying(true);
                             } else {
                               el?.pause();
                               setIsPlaying(false);
                             }
                           }}
                           className="w-10 h-10 bg-[#e11d48] rounded-full flex items-center justify-center hover:scale-105 active:scale-95 transition-all shrink-0"
                         >
                           {isPlaying ? <Pause className="w-5 h-5 fill-white" /> : <Play className="w-5 h-5 fill-white ml-0.5" />}
                         </button>
                         <div className="flex-1 h-1.5 bg-white/10 rounded-full relative overflow-hidden group cursor-pointer" onClick={(e) => {
                            const rect = e.currentTarget.getBoundingClientRect();
                            const x = e.clientX - rect.left;
                            const pct = x / rect.width;
                            if (audioRef.current) audioRef.current.currentTime = pct * duration;
                         }}>
                            <div className="absolute inset-y-0 left-0 bg-[#e11d48]" style={{ width: `${(currentTime/duration)*100}%` }} />
                         </div>
                         <span className="text-[10px] font-mono font-bold text-neutral-400 shrink-0">
                           {currentTime.toFixed(2)}s / {duration.toFixed(2)}s
                         </span>
                       </div>
                    </div>
                  </div>
                )}
              </div>

              <EditorControls
                type={type}
                fileName={file.name}
                targetFormat={target}
                onApplyPreset={applyPreset}
                options={options}
                setOptions={setOptions}
                currentTime={currentTime}
                duration={duration}
                isCropping={isCropping}
                setIsCropping={setIsCropping}
                onClose={onClose}
                onSave={handleSave}
              />
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
