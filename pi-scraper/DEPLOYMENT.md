# Raspberry Pi Scraper Deployment (Go)

This Go server replaces the legacy Node.js/Cloudflare scraper. It is designed to be lightweight, fast, and secure.

## Prerequisites
- Go 1.21+ installed on your Raspberry Pi.
- `yt-dlp` installed and available in the system PATH.

## Deployment Steps

1. **Transfer Code**:
   Copy the `pi-scraper` directory to your Raspberry Pi.

2. **Build**:
   On the Pi, run:
   ```bash
   cd pi-scraper
   go build -o omni-scraper
   ```

3. **Run**:
   ```bash
   ./omni-scraper
   ```
   The server will start on port `8080`.

4. **Expose via Cloudflare Tunnel**:
   If you have `cloudflared` installed, route your tunnel to `http://localhost:8080`.
   Example:
   ```bash
   cloudflared tunnel route dns <tunnel-name> scraper.yourdomain.com
   ```

5. **Update Frontend**:
   In your `.env` file in the main `Omni` project, update the scraper URL:
   ```env
   NEXT_PUBLIC_SCRAPER_API_URL=https://scraper.yourdomain.com
   ```

## API Endpoints
- `POST /extract`: Metadata extraction. Body: `{"url": "..."}`
- `GET /wake`: Health check.
