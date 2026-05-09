# OmniConvert

**The Ultimate Universal Media Downloader & Converter**

OmniConvert is a powerful, all-in-one web application that allows users to download media from thousands of websites (YouTube, TikTok, Reddit, Twitter, Spotify) and convert/edit those files entirely within their browser. 

By leveraging WebAssembly and a highly resilient 3-tier distributed backend, OmniConvert achieves blazing fast speeds with zero server compute costs for file conversions.

---

## 🌟 Key Features

### 1. Universal Media Downloader
- **1000+ Supported Sites:** Paste a link from almost any social media platform and instantly download the highest quality video or audio format.
- **Enterprise Anti-Bot Evasion:** Bypasses aggressive IP blocks and rate limits using dynamic client spoofing (`ios`, `tv`, `web_creator`) and Edge network routing.
- **Playlist & Batch Support:** Extract entire YouTube or Spotify playlists with a single click.

### 2. Client-Side Converter & Editor
- **Zero-Server Compute:** Uses `ffmpeg.wasm` to perform all heavy file conversions and trimming directly inside the user's browser CPU.
- **Format Conversion:** Instantly convert videos to MP4, WebM, or GIF, and extract audio to MP3, WAV, or OGG.
- **Precision Trimming:** Built-in UI to precisely cut and trim video or audio files before downloading.
- **100% Private:** Because conversions happen in the browser, your personal files are never uploaded to a server.

### 3. Premium UI/UX
- Built on **Next.js 14** and **React**.
- Fully responsive, dark-mode native interface with micro-animations and seamless error handling.

---

## 🏗️ The 3-Tier Architecture

OmniConvert is designed to bypass standard serverless Datacenter restrictions while keeping hosting costs at absolutely $0.

1. **The Frontend (Vercel)**
   - Hosts the Next.js React Application and the heavy FFmpeg WebAssembly binaries.
   - Includes a "Wake-On-Load" mechanic to instantly pre-warm the backend servers the second a user visits the site.

2. **The Edge Router (Cloudflare Workers)**
   - Located in the `cloudflare-proxy` folder.
   - Acts as a lightning-fast, stateless middleware. It hides the backend API URL, manages CORS, and natively processes extraction logic for Spotify and Reddit to save backend bandwidth.

3. **The Extraction Engine (Render)**
   - Located in the `ytdlp-render-server` folder.
   - A custom Dockerized Node.js API wrapping the absolute latest version of `yt-dlp`.
   - Dedicated solely to cracking complex signatures and bypassing YouTube's bot-walls that typically block Vercel and Cloudflare.

---

## 🚀 Deployment Instructions

### 1. The Extraction Backend (Render)
1. Push this repository to GitHub.
2. In your Render Dashboard, create a New **Web Service**.
3. Connect your repository and set the **Root Directory** to `ytdlp-render-server`.
4. Set the **Environment** to **Docker**.
5. Click **Create Web Service**.
6. Once deployed, copy the live Render URL.

### 2. The Middleware Proxy (Cloudflare)
1. Navigate to the `cloudflare-proxy` directory in your terminal.
2. Run `npx wrangler secret put BACKEND_API_URL` and paste your new Render URL.
3. Run `npx wrangler deploy` to push the worker to the Cloudflare Edge network.

### 3. The Frontend (Vercel)
1. Connect your GitHub repository to Vercel.
2. Under Environment Variables, add:
   - `NEXT_PUBLIC_CLOUDFLARE_PROXY_URL`: The URL of your deployed Cloudflare Worker.
3. Deploy!
