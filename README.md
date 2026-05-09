# OmniConvert - Universal Media Downloader

A high-performance, unrestricted media downloader built with Next.js, Cloudflare Workers, and a custom Dockerized `yt-dlp` backend.

## Architecture

This project is built using a highly resilient 3-tier architecture designed to bypass standard IP-bans and rate limits commonly associated with serverless environments:

1. **Frontend (Vercel)**
   - Built with Next.js 14 and React.
   - Utilizes Web Workers and WebAssembly (FFmpeg.wasm) to process file conversions directly in the user's browser, saving massive amounts of server bandwidth and compute.
   - Implements a "Wake-On-Load" trigger that securely pre-warms the backend extraction engine.

2. **Middleware Proxy (Cloudflare Workers)**
   - Located in the `cloudflare-proxy` directory.
   - Acts as an ultra-fast Edge router. It hides the backend URL, securely handles CORS, and routes massive requests away from the Vercel datacenter.
   - Automatically processes API fallbacks for Spotify, Reddit, and TikTok natively.

3. **Extraction Engine (Render)**
   - Located in the `ytdlp-render-server` directory.
   - A custom Dockerized Node.js API that wraps the absolute latest version of `yt-dlp`.
   - Bypasses YouTube's Datacenter "Sign in to confirm you're not a bot" walls by natively implementing Proof of Origin (PoTokens) and mobile client spoofing (`ios`, `tv`, `web_creator`).

## Deployment Instructions

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
