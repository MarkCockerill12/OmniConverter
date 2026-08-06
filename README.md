# Omni

**The Ultimate Universal Media Downloader, Converter & 3D Viewer**

Omni is a high-performance web suite designed for media manipulation and 3D visualization. It allows users to download and convert social media content while providing a specialized "3D Forge" for inspecting and repairing Wii-era 3D models.

---

## 🌟 Key Features

### 1. 3D Forge (Viewer & Repair)
- **Multi-Format Support:** Inspect DAE (Collada), GLTF, GLB, OBJ, STL, FBX and Wii MDL0 files.
- **Wii Model Optimizer:** Automatically repairs common issues with Wii/GameCube DAE files, including:
  - **The "Cyclops" Fix:** Automatically detects and resolves single-eye texture mapping by preferring double-eye `_fix` textures.
  - **Transparency Restoration:** Surgical `alphaTest` and `renderOrder` tuning to restore missing foreheads, mouths, and translucent accessories.
  - **Archive Discovery:** Drop a ZIP or `.szs` and Omni resolves textures, discovers every model inside, and maps materials.
- **Verified against retail data:** a real Mario Kart Wii `.szs` (Yaz0 → U8 → BRRES → MDL0/TEX0) parses to correct geometry, material names, draw-call links and textures, and exports to GLB with its images embedded.
- **Master GLB Export:** Combine multiple models, textures, and repairs into a single, standard-compliant GLB file — optionally Meshopt-compressed with a texture-size cap.
- **Inspection tools:** shaded / wireframe / normals / UV-checker display modes, orthographic toggle, frame-all camera, and live triangle, vertex and texture counts.
- **Unlit mode:** console textures already have lighting baked in, so models parsed from MDL0 default to unlit rendering and show their authored colours exactly. Toggle it with the sun button.
- **Animation playback:** GLTF and FBX clips play in the viewport with a scrubbable timeline and clip picker.

### 2. Universal Media Downloader
- **1000+ Supported Sites:** Seamlessly download from YouTube, TikTok, Reddit, Twitter, and more.
- **Resilient Extraction:** Uses a distributed 3-tier architecture to bypass rate limits and bot detection.
- **Playlist Support:** Extract full YouTube metadata for easy batch processing.

### 3. Client-Side Converter & Editor
- **Four engines, picked automatically.** Every job is routed to the cheapest one that can do it, and the queue shows which ran:
  | Badge | Engine | Used for |
  | --- | --- | --- |
  | `Instant` | Canvas / WebAudio | image↔image, SVG raster, ICO packing, video frame grabs |
  | `GPU` | WebCodecs (mediabunny) | hardware video/audio transcodes, trimming, resizing, subtitle burn-in |
  | `WASM` | FFmpeg.wasm | GIF palettes, colour keying, speed changes, exotic codecs |
  | `3D` / `DOC` / `PACK` | Three.js, pdf.js, fflate | models, documents, archives |
- **Privacy First:** No files are ever uploaded to a server for processing; your data stays in your browser.
- **Parallel queue:** up to three jobs at once (FFmpeg work is serialised internally), with per-file downloads and a **Download all (.zip)** button.
- **The queue survives a refresh** — files, formats and edits are kept in IndexedDB.
- **Conversion matrix:**
  | Source | Targets |
  | --- | --- |
  | Image (PNG/JPG/WEBP/GIF/TIFF/BMP/ICO/AVIF) | PNG, JPG, JPEG, WEBP, GIF, TIFF, BMP, ICO, PDF |
  | SVG | PNG, JPG, WEBP, ICO, PDF |
  | Video (MP4/WEBM/MKV/MOV/AVI/TS) | video, audio, GIF, or a single frame as an image |
  | Audio (MP3/WAV/FLAC/OGG/M4A/AAC/OPUS) | MP3, WAV, FLAC, OGG, M4A |
  | PDF | PNG, JPG, WEBP (multi-page ⇒ ZIP), TXT |
  | 3D (GLB/GLTF/OBJ/STL/FBX/DAE/MDL0) | GLB, GLTF, OBJ, STL |
  | Archive (ZIP/SZS/TAR/GZ) | ZIP, TAR, GZ — or unpacked and merged into a model |

### 4. Editor
Crop, trim, colour-key, scale by percentage, encoder quality, EXIF stripping, frame rate,
playback speed, target file size (bitrate solved from the clip duration), `.srt`/`.vtt`
burn-in, and one-click presets (Discord 10 MB, WhatsApp 16 MB, Instagram 1:1, Web 720p,
Share GIF, Podcast MP3, Web image, Thumbnail).

---

## 🏗️ The 3-Tier Architecture

Omni is designed to be highly resilient and cost-effective by distributing tasks across three distinct layers:

1.  **The Frontend (Vercel)**
    - Next.js 15 application hosting the UI. Every conversion is client-side; the
      only server routes are `/api/extract` (yt-dlp fallback) and `/api/proxy`
      (CORS passthrough for media downloads).
2.  **The Edge Router (Cloudflare Workers)**
    - Located in `/cloudflare-proxy`.
    - Acts as a stateless middleware to bypass CORS, protect backend IPs, and perform lightweight extraction for platforms like Reddit and Spotify.
3.  **The Extraction Engine (Raspberry Pi / Go)**
    - Located in `/pi-scraper`.
    - A high-performance Go server wrapping `yt-dlp`. By running on local hardware (like a Raspberry Pi), it avoids the IP blacklists common to cloud data centers.

---

## 🧑‍💻 Development

```bash
pnpm dev          # Next.js dev server
pnpm build        # production build
pnpm lint         # oxlint (fast Rust linter)
pnpm typecheck    # tsc --noEmit
pnpm e2e          # headless-Chrome conversion suite (needs `pnpm start` running)
```

`pnpm e2e` drives a real browser over CDP against `http://localhost:3000`, feeding
generated media through every conversion path and asserting on the produced files.
Binary fixtures placed in `scripts/fixtures/` are injected into the page automatically —
the Wii tests use a retail `.szs` and include a canvas pixel-histogram check that catches
UV and texture-decode regressions that still "look like a model".

### Environment

| Variable | Purpose |
| --- | --- |
| `NEXT_PUBLIC_SCRAPER_API_URL` | Pi/Cloudflare extract endpoint. Falls back to the local `/api/extract` route. |
| `NEXT_PUBLIC_CLOUDFLARE_PROXY_URL` | Deployed Cloudflare Worker URL. |
| `YT_DLP_PATH` | Optional path to a local `yt-dlp` binary used by `/api/extract`. Resolved from `PATH` when unset. |

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
   - `NEXT_PUBLIC_SCRAPER_API_URL`: Your scraper endpoint.
3. Deploy!
