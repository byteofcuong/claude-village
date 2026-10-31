import { defineConfig } from 'vite';

// Same exposure rules as the production server: loopback only, exact hosts.
export default defineConfig({
  root: 'src/client',
  publicDir: '../../assets/generated',
  build: { outDir: '../../dist/client', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1200 },
  server: { host: '127.0.0.1', port: 5173, strictPort: true, allowedHosts: ['127.0.0.1', 'localhost'], cors: false },
});
