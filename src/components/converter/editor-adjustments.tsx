"use client";

import { Archive, FlipHorizontal2, FlipVertical2, Minimize2, RotateCcw, RotateCw, SlidersHorizontal, Waves } from "lucide-react";
import { getFileCategory, type CompressionLevel, type EditOptions } from "@/lib/formats";
import { COMPRESSION_LEVELS, describeCompression } from "@/lib/compression";
import { Choice, EditorSection, GhostButton, HINT_CLASS, Slider, TimeField, Toggle } from "./editor-parts";

type Patch = (next: Partial<EditOptions>) => void;

interface SectionProps {
  options: EditOptions;
  patch: Patch;
}

/** The one compression dial, with a line saying what it means for this output. */
export function CompressionSection({ options, patch, fileName, targetFormat }: SectionProps & { fileName: string; targetFormat: string }) {
  const target = targetFormat || fileName.split(".").pop() || "";
  const category = getFileCategory(`x.${target}`) === "Unrecognized" ? getFileCategory(fileName) : getFileCategory(`x.${target}`);
  return (
    <EditorSection title="Compression" icon={<Minimize2 className="w-4 h-4" />}>
      <div className="space-y-3">
        {/* "Off" on its own row, the four levels as a 2x2 block: fits the narrowest rail. */}
        <Choice columns={1} value={options.compression ? undefined : "off"} options={[{ id: "off", label: "Off" }]} onChange={() => patch({ compression: undefined })} />
        <Choice<CompressionLevel>
          columns={2}
          value={options.compression}
          options={COMPRESSION_LEVELS}
          // A level owns the quality settings until one is moved by hand again.
          onChange={(compression) => patch({ compression, quality: undefined, audioBitrate: undefined })}
        />
        <p className={HINT_CLASS} data-omni="compression-hint">{describeCompression(category, target, options.compression)}</p>
      </div>
    </EditorSection>
  );
}

const PACK_LEVELS = [
  { id: 0, label: "Store", title: "No compression: fastest, largest" },
  { id: 1, label: "Fast" },
  { id: 6, label: "Normal" },
  { id: 9, label: "Maximum", title: "Slowest, smallest" },
];

export function PackLevelSection({ options, patch, targetFormat }: SectionProps & { targetFormat: string }) {
  const isTar = targetFormat.toUpperCase() === "TAR";
  return (
    <EditorSection title="Pack Level" icon={<Archive className="w-4 h-4" />}>
      <div className="space-y-3">
        <Choice columns={4} value={isTar ? undefined : options.archiveLevel ?? 6} options={PACK_LEVELS} onChange={(archiveLevel) => patch({ archiveLevel })} />
        <p className={HINT_CLASS}>
          {isTar ? "TAR only bundles files; choose ZIP or GZ to compress them." : "Always lossless: every file unpacks byte for byte."}
        </p>
      </div>
    </EditorSection>
  );
}

/** Rotation, mirroring and colour correction for pictures and video. */
export function AdjustSection({ options, patch }: SectionProps) {
  const turn = (by: number) => patch({ rotate: ((((options.rotate ?? 0) + by) % 360) + 360) % 360 || undefined });
  const touched = options.rotate || options.flipH || options.flipV || options.grayscale || options.blur ||
    [options.brightness, options.contrast, options.saturation].some((v) => v !== undefined && v !== 100);
  return (
    <EditorSection title="Adjust" icon={<SlidersHorizontal className="w-4 h-4" />}>
      <div className="space-y-5">
        <div className="grid grid-cols-4 gap-2">
          <GhostButton title="Rotate left" onClick={() => turn(-90)}><RotateCcw className="w-4 h-4" /></GhostButton>
          <GhostButton title="Rotate right" onClick={() => turn(90)}><RotateCw className="w-4 h-4" /></GhostButton>
          <GhostButton title="Flip horizontally" active={!!options.flipH} onClick={() => patch({ flipH: !options.flipH || undefined })}><FlipHorizontal2 className="w-4 h-4" /></GhostButton>
          <GhostButton title="Flip vertically" active={!!options.flipV} onClick={() => patch({ flipV: !options.flipV || undefined })}><FlipVertical2 className="w-4 h-4" /></GhostButton>
        </div>
        <Slider label="Brightness" min={0} max={200} suffix="%" value={options.brightness ?? 100} onChange={(brightness) => patch({ brightness })} />
        <Slider label="Contrast" min={0} max={200} suffix="%" value={options.contrast ?? 100} onChange={(contrast) => patch({ contrast })} />
        <Slider label="Saturation" min={0} max={200} suffix="%" value={options.saturation ?? 100} onChange={(saturation) => patch({ saturation })} />
        <Slider label="Blur" min={0} max={20} step={0.5} suffix="px" value={options.blur ?? 0} onChange={(blur) => patch({ blur: blur || undefined })} />
        <Toggle label="Black and white" checked={!!options.grayscale} onChange={(on) => patch({ grayscale: on || undefined })} />
        {touched ? (
          <button
            className="text-[8px] font-black text-[#e11d48] uppercase hover:underline"
            onClick={() => patch({ rotate: undefined, flipH: undefined, flipV: undefined, brightness: undefined, contrast: undefined, saturation: undefined, blur: undefined, grayscale: undefined })}
          >
            Reset adjustments
          </button>
        ) : null}
      </div>
    </EditorSection>
  );
}

/** Gain, fades and loudness for audio, and for the soundtrack of a video. */
export function AudioFxSection({ options, patch, isVideo }: SectionProps & { isVideo: boolean }) {
  const seconds = (key: "fadeIn" | "fadeOut", label: string) => (
    <TimeField label={label} value={options[key] ?? 0} onChange={(value) => patch({ [key]: value || undefined })} />
  );
  return (
    <EditorSection title="Sound" icon={<Waves className="w-4 h-4" />}>
      <div className="space-y-5">
        {isVideo && <Toggle label="Remove audio track" checked={!!options.mute} onChange={(on) => patch({ mute: on || undefined })} />}
        {!options.mute && (
          <>
            <Slider label="Volume" min={0} max={300} step={5} suffix="%" value={options.volume ?? 100} onChange={(volume) => patch({ volume: volume === 100 ? undefined : volume })} />
            <div className="grid grid-cols-2 gap-3">
              {seconds("fadeIn", "Fade in")}
              {seconds("fadeOut", "Fade out")}
            </div>
            <Toggle label="Normalise loudness" checked={!!options.normalize} onChange={(on) => patch({ normalize: on || undefined })} />
            <Toggle label="Mix down to mono" checked={!!options.mono} onChange={(on) => patch({ mono: on || undefined })} />
          </>
        )}
      </div>
    </EditorSection>
  );
}
