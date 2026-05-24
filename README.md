# Omni

**The Ultimate Universal Media Downloader, Converter & 3D Viewer**

Omni is a high-performance web suite designed for media manipulation and 3D visualization. It allows users to download and convert social media content while providing a specialized "3D Forge" for inspecting and repairing Wii-era 3D models.

---

## 🌟 Key Features

### 1. 3D Forge (Viewer & Repair)
- **Multi-Format Support:** Inspect DAE (Collada), GLTF, GLB, OBJ, and STL files.
- **Wii Model Optimizer:** Automatically repairs common issues with Wii/GameCube DAE files, including:
  - **The "Cyclops" Fix:** Automatically detects and resolves single-eye texture mapping by preferring double-eye `_fix` textures.
  - **Transparency Restoration:** Surgical `alphaTest` and `renderOrder` tuning to restore missing foreheads, mouths, and translucent accessories.
  - **Archive Discovery:** Drop a ZIP file and Omni will automatically resolve textures, discover multiple models, and map materials.
- **Master GLB Export:** Combine multiple models, textures, and repairs into a single, standard-compliant GLB file.

### 2. Universal Media Downloader
- **1000+ Supported Sites:** Seamlessly download from YouTube, TikTok, Reddit, Twitter, and more.
- **Resilient Extraction:** Uses a distributed 3-tier architecture to bypass rate limits and bot detection.
- **Playlist Support:** Extract full YouTube metadata for easy batch processing.

### 3. Client-Side Converter & Editor
- **FFmpeg.Wasm Engine:** Perform all video/audio conversions and trimming locally on your machine.
- **Privacy First:** No files are ever uploaded to a server for processing; your data stays in your browser.
- **Advanced Formats:** Convert to MP4, WebM, GIF, MP3, WAV, or OGG with precision trimming.

---

## 🏗️ The 3-Tier Architecture

Omni is designed to be highly resilient and cost-effective by distributing tasks across three distinct layers:

1.  **The Frontend (Vercel)**
    - Next.js 15 application hosting the UI and FFmpeg WebAssembly binaries.
2.  **The Edge Router (Cloudflare Workers)**
    - Located in `/cloudflare-proxy`.
    - Acts as a stateless middleware to bypass CORS, protect backend IPs, and perform lightweight extraction for platforms like Reddit and Spotify.
3.  **The Extraction Engine (Raspberry Pi / Go)**
    - Located in `/pi-scraper`.
    - A high-performance Go server wrapping `yt-dlp`. By running on local hardware (like a Raspberry Pi), it avoids the IP blacklists common to cloud data centers.

---

## 🚀 Deployment Instructions

### 1. The Extraction Backend (Go)
1. Build and run the Go server in the `/pi-scraper` directory on your local server or Raspberry Pi.
2. Expose the port (default `8080`) to the internet (e.g., via Cloudflare Tunnel).
3. Follow the details in `/pi-scraper/DEPLOYMENT.md`.

### 2. The Edge Proxy (Cloudflare)
1. Navigate to `/cloudflare-proxy`.
2. Run `npx wrangler secret put BACKEND_API_URL` and provide your scraper URL.
3. Run `npx wrangler deploy` to push the worker to the Cloudflare Edge network.

### 3. The Frontend (Vercel)
1. Connect your GitHub repository to Vercel.
2. Under Environment Variables, add:
   - `NEXT_PUBLIC_CLOUDFLARE_PROXY_URL`: The URL of your deployed Cloudflare Worker.
3. Deploy!
