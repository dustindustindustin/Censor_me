import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Use 127.0.0.1 explicitly (not 'localhost') to avoid the Windows DNS quirk
      // where localhost resolves to ::1 (IPv6) before 127.0.0.1 (IPv4), causing
      // Node.js to hang for ~10s waiting for the IPv6 connection to time out.

      // REST API calls → http://127.0.0.1:8010/*
      '/api': {
        target: 'http://127.0.0.1:8010',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
      // Scan pipeline WebSocket → ws://127.0.0.1:8010/scan/progress/*
      '/ws/scan': {
        target: 'ws://127.0.0.1:8010',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, ''),
      },
      // Export pipeline WebSocket → ws://127.0.0.1:8010/export/progress/*
      '/ws/export': {
        target: 'ws://127.0.0.1:8010',
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, ''),
      },
    },
  },
})
