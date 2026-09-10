import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

/**
 * 渲染进程构建配置。
 * - root: renderer/       渲染层源码独立成目录，主进程代码不会被误打包
 * - base: './'            打包后由 file:// 加载，必须使用相对路径
 * - outDir: dist/         主进程按 dist/index.html 加载
 * - 端口固定 5273，避免与常见的 5173 冲突，dev 脚本据此等待就绪
 */
export default defineConfig({
  root: fileURLToPath(new URL('./renderer', import.meta.url)),
  base: './',
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./renderer', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  server: {
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    // Electron 38 内置 Chromium 140，可以放心用现代语法
    target: 'chrome130',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        // 把 vue 单独拆出来，主 chunk 更小、便于排查体积问题
        manualChunks: {
          vendor: ['vue'],
        },
      },
    },
  },
});
