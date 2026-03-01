import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5175,
    strictPort: true,
    // fs.watch() is broken on WSL2 filesystem when accessed from Windows.
    // usePolling avoids EISDIR / ENOENT errors on the mapped UNC drive (Z:).
    watch: process.platform === 'win32' ? { usePolling: true, interval: 500 } : undefined,
  },
  clearScreen: false,
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: ['es2021', 'chrome97', 'safari13'],
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
    outDir: 'dist',
  },
})
