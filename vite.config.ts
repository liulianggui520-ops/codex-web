import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { proxy: { '/api': 'http://127.0.0.1:47832', '/ws': { target: 'ws://127.0.0.1:47832', ws: true } } }, build: { sourcemap: false, chunkSizeWarningLimit: 700 } });
