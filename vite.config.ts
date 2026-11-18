import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH 用于 GitHub Pages 子路径部署（如 /X-Buddy/），本地开发为 /
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  test: { environment: 'node', include: ['tests/**/*.test.ts'] },
} as any);
