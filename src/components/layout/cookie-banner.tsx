"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Cookie, X } from "lucide-react";

export function CookieBanner() {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Check if the user has already accepted the storage/cookie policy
    const consent = localStorage.getItem("omni_storage_consent_accepted");
    if (!consent) {
      // Small delay before showing to ensure smooth page load transition
      const timer = setTimeout(() => {
        setIsVisible(true);
      }, 1500);
      return () => clearTimeout(timer);
    }
  }, []);

  const handleAccept = () => {
    localStorage.setItem("omni_storage_consent_accepted", "true");
    setIsVisible(false);
  };

  return (
    <AnimatePresence>
      {isVisible && (
        <motion.div
          initial={{ opacity: 0, y: 50, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 30, scale: 0.95 }}
          transition={{ duration: 0.4, ease: "easeOut" }}
          className="fixed bottom-6 right-6 z-[150] w-full max-w-[340px] bg-[#1f2228]/95 backdrop-blur-lg border border-white/10 rounded-2xl p-5 shadow-[0_10px_40px_rgba(0,0,0,0.5)]"
        >
          <div className="flex items-start gap-3">
            <div className="p-2 bg-[#e11d48]/10 border border-[#e11d48]/20 rounded-xl text-[#e11d48] shrink-0">
              <Cookie className="w-5 h-5" />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold uppercase tracking-wider text-white">Storage Notice</h4>
                <button 
                  onClick={handleAccept}
                  className="text-neutral-500 hover:text-white transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <p className="text-xs text-neutral-400 mt-2 leading-relaxed">
                This website uses local storage and cookies to save authorization tokens and persist layout safe mode settings. No tracking or advertising data is collected.
              </p>
              <div className="mt-4 flex justify-end">
                <button
                  onClick={handleAccept}
                  className="px-4 py-1.5 bg-[#e11d48] hover:bg-[#be123c] rounded-lg text-[10px] font-black uppercase tracking-wider text-white transition-all active:scale-[0.97]"
                >
                  Accept & Close
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
