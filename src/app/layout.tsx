import type { Metadata } from "next";
import { Navbar } from "@/components/layout/navbar";
import "./globals.css";

export const metadata: Metadata = {
  title: "Omni-Convert | Universal Browser-Based Toolkit",
  description: "Zero-cost, unlimited universal converter and downloader running entirely in your browser.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-[#0f1115] text-white">
        <Navbar />
        {children}
      </body>
    </html>
  );
}
