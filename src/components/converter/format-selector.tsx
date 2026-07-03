"use client";

import { useState, useRef, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, ChevronDown, CheckCircle2, CircleDashed } from "lucide-react";
import { cn } from "@/lib/utils";

export type Category = "Image" | "3D Model" | "Document" | "Video" | "Audio" | "Archive" | "Unrecognized";

export const FORMAT_CATEGORIES: Record<Category, string[]> = {
  "Image": ["PNG", "JPG", "JPEG", "WEBP", "GIF", "TIFF", "BMP", "SVG"],
  "3D Model": ["GLB", "GLTF", "OBJ", "STL", "FBX", "DAE", "3MF", "PLY", "SZS", "MDL0"],
  "Document": ["PDF", "DOCX", "DOC", "TXT", "RTF", "MD"],
  "Video": ["MP4", "WEBM", "MKV", "MOV", "AVI"],
  "Audio": ["MP3", "WAV", "FLAC", "OGG", "M4A"],
  "Archive": ["ZIP", "RAR", "7Z", "TAR", "GZ"],
  "Unrecognized": []
};

// Conversion Restriction Map: Source Category -> Allowed Target Categories
const ALLOWED_CONVERSIONS: Record<Category, Category[]> = {
  "Image": ["Image"],
  "Video": ["Video", "Audio"],
  "Audio": ["Audio"],
  "3D Model": ["3D Model"],
  "Document": ["Document"],
  "Archive": ["Archive", "3D Model"],
  "Unrecognized": []
};

export function getFileCategory(fileName: string): Category {
  const ext = fileName.split('.').pop()?.toUpperCase() || "";
  for (const [cat, exts] of Object.entries(FORMAT_CATEGORIES)) {
    if (exts.includes(ext)) return cat as Category;
  }
  return "Unrecognized";
}

export function FormatDropdown({ 
  value, 
  onChange, 
  sourceFileName = "",
  label = "Select Format" 
}: { 
  value: string; 
  onChange: (val: string) => void;
  sourceFileName?: string;
  label?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [activeCategory, setActiveCategory] = useState<Category>("Image");
  const [search, setSearch] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);

  const sourceCategory = useMemo(() => getFileCategory(sourceFileName), [sourceFileName]);
  const allowedCategories = useMemo(() => {
    return ALLOWED_CONVERSIONS[sourceCategory] || ["Image"];
  }, [sourceCategory]);

  useEffect(() => {
    if (!allowedCategories.includes(activeCategory)) {
      setActiveCategory(allowedCategories[0]);
    }
  }, [allowedCategories, activeCategory]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const filteredFormats = useMemo(() => {
    let formats = FORMAT_CATEGORIES[activeCategory] || [];
    if (activeCategory === "3D Model") {
      formats = ["GLB", "GLTF", "OBJ", "STL"];
    }
    if (!search) return formats;
    return formats.filter(f => f.toLowerCase().includes(search.toLowerCase()));
  }, [activeCategory, search]);

  return (
    <div className="relative" ref={dropdownRef}>
      <button 
        onClick={() => setIsOpen(!isOpen)}
        className={cn(
          "flex items-center gap-2 px-4 py-2 bg-[#e11d48] hover:bg-[#be123c] text-white rounded-md font-bold transition-all h-10 min-w-[120px] shadow-lg shadow-[#e11d48]/10",
          !value && "bg-[#374151] hover:bg-[#4b5563] shadow-none"
        )}
      >
        <span>{value || label}</span>
        <ChevronDown className={cn("w-4 h-4 transition-transform", isOpen && "rotate-180")} />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div 
            initial={{ opacity: 0, y: 10, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 10, scale: 0.95 }}
            className="absolute z-[100] mt-2 w-[480px] bg-white text-[#1f2228] rounded-lg shadow-2xl border border-neutral-200 overflow-hidden flex right-0 origin-top-right"
          >
            {/* Sidebar Categories */}
            <div className="w-1/3 border-r border-neutral-100 bg-neutral-50 py-2">
              {allowedCategories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={cn(
                    "w-full text-left px-4 py-2 text-sm font-semibold transition-colors",
                    activeCategory === cat ? "text-[#e11d48] bg-white border-r-2 border-[#e11d48]" : "text-neutral-500 hover:text-neutral-900"
                  )}
                >
                  {cat}
                </button>
              ))}
            </div>

            {/* Content Area */}
            <div className="w-2/3 p-4 bg-white">
              <div className="relative mb-4">
                <Search className="absolute left-3 top-2.5 w-4 h-4 text-neutral-400" />
                <input 
                  type="text" 
                  placeholder="Search Format"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full pl-9 pr-4 py-2 bg-neutral-50 border border-neutral-200 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-[#e11d48]/20 focus:border-[#e11d48]"
                />
              </div>

              <div className="grid grid-cols-3 gap-2 max-h-[240px] overflow-y-auto pr-2 custom-scrollbar">
                {filteredFormats.length > 0 ? (
                  filteredFormats.map(fmt => (
                    <button
                      key={fmt}
                      onClick={() => {
                        onChange(fmt);
                        setIsOpen(false);
                      }}
                      className={cn(
                        "px-2 py-2 text-xs font-bold rounded border transition-all text-center uppercase tracking-tighter",
                        value === fmt 
                          ? "bg-[#e11d48] text-white border-[#e11d48]" 
                          : "bg-neutral-800 text-white border-neutral-700 hover:bg-[#e11d48] hover:border-[#e11d48]"
                      )}
                    >
                      {fmt}
                    </button>
                  ))
                ) : (
                  <p className="col-span-3 text-center py-8 text-neutral-400 text-xs">No formats found</p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function StatusBadge({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className={cn(
      "flex items-center gap-2 px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest border transition-all duration-500",
      ready 
        ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" 
        : "bg-white/5 text-neutral-500 border-white/5"
    )}>
      {ready ? <CheckCircle2 className="w-3 h-3" /> : <CircleDashed className="w-3 h-3 animate-spin" />}
      {label}
    </div>
  );
}
