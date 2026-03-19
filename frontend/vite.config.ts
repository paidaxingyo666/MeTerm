import { defineConfig } from 'vite'

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:8080',
      '/ws/': {
        target: 'ws://localhost:8080',
        ws: true,
        configure: (proxy) => {
          // Silence proxy errors (e.g. client reconnect attempts before session exists)
          proxy.on('error', () => {})
        }
      }
    }
  }
})
