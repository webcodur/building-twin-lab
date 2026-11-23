import { defineConfig } from 'vite';

// GitHub Pages는 /<저장소>/ 하위 경로에 올라간다. 상대 경로로 빌드해 어느 경로에서든 돈다.
export default defineConfig({
  base: './',
  // three.js 본체가 약 700KB, IFC 실험을 열 때만 받는 web-ifc가 약 3.6MB(gzip 420KB)다.
  build: { chunkSizeWarningLimit: 4000 },
});
