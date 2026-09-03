import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/postcss';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/Choco-Barcode/',
  css: { postcss: { plugins: [tailwindcss()] } },
  plugins: [react()],
});
