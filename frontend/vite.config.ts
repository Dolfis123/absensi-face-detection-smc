import basicSsl from '@vitejs/plugin-basic-ssl';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Kamera & GPS di HP hanya jalan lewat HTTPS (atau localhost).
// Jalankan `npm run dev -- --host` lalu buka https://<IP-laptop>:5173 dari HP.
export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
});
