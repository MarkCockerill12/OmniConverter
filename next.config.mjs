import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          // `credentialless` keeps the page cross-origin isolated for
          // FFmpeg.wasm while still allowing no-cors thumbnails (ytimg and
          // friends) that `require-corp` blocks outright.
          { key: 'Cross-Origin-Embedder-Policy', value: 'credentialless' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        ],
      },
    ];
  },
  webpack: (config, { isServer, webpack }) => {
    if (!isServer) {
      // @gltf-transform/core ships NodeIO alongside WebIO; only the browser
      // half is ever reached, so the Node built-ins it imports are stubbed.
      config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false };
      config.plugins.push(
        new webpack.NormalModuleReplacementPlugin(
          /^node:(fs|path|os|url|crypto|stream|fs\/promises)$/,
          fileURLToPath(new URL("./src/lib/node-stub.cjs", import.meta.url))
        )
      );
    }
    return config;
  },
};

export default nextConfig;
