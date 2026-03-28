import { defineConfig } from 'vite'

// Relative URLs so `dist/index.html` works when opened via file:// or from a subpath.
export default defineConfig({
  base: './',
  server: {
    host: true,
    // Use same default port as `vite preview` so dev matches what works if 5173 is taken by another app.
    port: 4173,
    strictPort: false,
  },
  preview: {
    host: true,
    port: 4173,
    strictPort: false,
  },
})
