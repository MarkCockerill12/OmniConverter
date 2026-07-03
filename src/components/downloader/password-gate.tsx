"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Lock, ShieldAlert, Loader2, Eye, EyeOff, CheckCircle } from "lucide-react";
import { cn } from "@/lib/utils";

// Hash configuration
const SALT = "omni_downloader_salt_2026_prod";
const PEPPER = "omni_converter_pepper_key";
const CORRECT_HASH = "faceee1c6b2c08ffbf2c9d6bf1d234802b53428fbf019176c0b58580e94e314f";

interface PasswordGateProps {
  onAuthorized: () => void;
}

export function PasswordGate({ onAuthorized }: PasswordGateProps) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check if device is already authorized
    const isAuth = localStorage.getItem("omni_downloader_authorized") === "true";
    if (isAuth) {
      onAuthorized();
    } else {
      setIsLoading(false);
    }
  }, [onAuthorized]);

  const hashPassword = async (pwd: string): Promise<string> => {
    const encoder = new TextEncoder();
    // Combine salt + password + pepper
    const data = encoder.encode(SALT + pwd + PEPPER);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;

    setIsVerifying(true);
    setError(null);

    try {
      // Small artificial delay for a premium scanning/verification feel
      await new Promise((resolve) => setTimeout(resolve, 800));

      const inputHash = await hashPassword(password);

      if (inputHash === CORRECT_HASH) {
        setSuccess(true);
        localStorage.setItem("omni_downloader_authorized", "true");
        // Wait for success animation before letting the user in
        await new Promise((resolve) => setTimeout(resolve, 1000));
        onAuthorized();
      } else {
        setError("Invalid decryption key. Please try again.");
        setPassword("");
      }
    } catch (err) {
      console.error("Verification error:", err);
      setError("An error occurred during verification.");
    } finally {
      setIsVerifying(false);
    }
  };

  if (isLoading) {
    return (
      <div className="min-h-[70vh] flex items-center justify-center">
        <Loader2 className="w-10 h-10 text-[#e11d48] animate-spin" />
      </div>
    );
  }

  return (
    <div className="max-w-[1200px] mx-auto px-6 py-12 min-h-[75vh] flex items-center justify-center">
      <motion.div
        initial={{ opacity: 0, y: 30 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: "easeOut" }}
        className="w-full max-w-md"
      >
        <div className="bg-[#1f2228] rounded-[2.5rem] border border-white/10 shadow-[0_0_50px_rgba(225,29,72,0.08)] p-8 md:p-10 relative overflow-hidden">
          {/* Top glowing ambient gradient */}
          <div className="absolute top-0 left-1/4 right-1/4 h-[1px] bg-gradient-to-r from-transparent via-[#e11d48]/50 to-transparent" />
          
          <div className="text-center mb-8">
            <div className="inline-flex p-4 rounded-2xl bg-white/5 border border-white/10 mb-4 text-[#e11d48]">
              {success ? (
                <CheckCircle className="w-8 h-8 animate-bounce text-green-400" />
              ) : (
                <Lock className="w-8 h-8" />
              )}
            </div>
            <h1 className="text-3xl font-black tracking-tight uppercase italic mb-2">
              Access <span className="text-[#e11d48]">Restricted.</span>
            </h1>
            <p className="text-sm text-neutral-400">
              This media downloader module is protected. Enter the decryption key to access.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                placeholder="Enter password..."
                value={password}
                disabled={isVerifying || success}
                onChange={(e) => {
                  setPassword(e.target.value);
                  if (error) setError(null);
                }}
                className={cn(
                  "w-full h-14 pl-5 pr-12 bg-black/20 border rounded-xl focus:outline-none transition-all text-lg font-medium",
                  error
                    ? "border-red-500/50 focus:ring-4 focus:ring-red-500/10 focus:border-red-500"
                    : "border-white/5 focus:ring-4 focus:ring-[#e11d48]/10 focus:border-[#e11d48]"
                )}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                disabled={isVerifying || success}
                className="absolute right-4 top-1/2 -translate-y-1/2 text-neutral-500 hover:text-white transition-colors"
              >
                {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
              </button>
            </div>

            <button
              type="submit"
              disabled={!password || isVerifying || success}
              className={cn(
                "w-full h-14 rounded-xl font-black uppercase tracking-widest text-sm transition-all flex items-center justify-center gap-2",
                success
                  ? "bg-green-500 text-white"
                  : "bg-[#e11d48] hover:bg-[#be123c] disabled:opacity-50 active:scale-[0.98]"
              )}
            >
              {isVerifying ? (
                <>
                  Verifying <Loader2 className="w-4 h-4 animate-spin" />
                </>
              ) : success ? (
                <>
                  Granted <CheckCircle className="w-4 h-4" />
                </>
              ) : (
                <>
                  Unlock Access <Lock className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <AnimatePresence>
            {error && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: "auto" }}
                exit={{ opacity: 0, height: 0 }}
                className="mt-4"
              >
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400 text-sm font-semibold">
                  <ShieldAlert className="w-4 h-4 shrink-0" />
                  <p>{error}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
