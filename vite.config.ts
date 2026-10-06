import { defineConfig } from 'vite';

// base: './' — dist/ をどのサブパス（例 /<repo>/）に置いても動くように相対パスで出力する
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  optimizeDeps: { exclude: ['@huggingface/transformers'] },
});
