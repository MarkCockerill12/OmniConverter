"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileBox, DownloadCloud } from "lucide-react";
import { cn } from "@/lib/utils";

export function Navbar() {
  const pathname = usePathname();

  const navItems = [
    { name: "Converter & 3D", href: "/", icon: FileBox },
    { name: "Downloader", href: "/downloader", icon: DownloadCloud },
  ];

  return (
    <nav className="h-20 border-b border-white/5 bg-[#0f1115]/80 backdrop-blur-md flex items-center px-8 justify-between z-[100]">
      <div className="flex items-center gap-12">
        <Link href="/" className="flex items-center gap-3 group">
          <span className="text-2xl font-black tracking-tighter italic">OMNI-CONVERT</span>
        </Link>
        
        <div className="flex items-center gap-4">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold uppercase tracking-widest transition-all",
                pathname === item.href 
                  ? "bg-white/10 text-white" 
                  : "text-neutral-500 hover:text-white hover:bg-white/5"
              )}
            >
              <item.icon className="w-4 h-4" />
              {item.name}
            </Link>
          ))}
        </div>
      </div>
    </nav>
  );
}
