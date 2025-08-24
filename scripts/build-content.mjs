import { build } from 'vite';
import { resolve } from 'path';

// Build content script as a single bundle
await build({
  configFile: false,
  build: {
    lib: {
      entry: resolve('src/content/content.ts'),
      name: 'ContentScript',
      formats: ['iife'],
      fileName: () => 'content.js'
    },
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        manualChunks: undefined
      },
      external: []
    }
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@content': resolve('src/content'),
      '@background': resolve('src/background'),
      '@popup': resolve('src/popup'),
    },
  },
});

console.log('✅ Content script built as single file');
