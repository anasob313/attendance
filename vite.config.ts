import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

// BASE_PATH lets the same build run at a sub-path, e.g. GitHub Pages
// (https://user.github.io/repo/ → BASE_PATH=/repo/). Defaults to the root.
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  base,
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      injectRegister: false,
      injectManifest: { globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'] },
      manifest: {
        id: base,
        name: 'Attendance Tracker',
        short_name: 'Attendance',
        description: 'Personal attendance tracker: clock in/out, remote work, leave and monthly reports.',
        start_url: base,
        scope: base,
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#09090b',
        theme_color: '#09090b',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  build: { target: 'es2020', sourcemap: false },
});
