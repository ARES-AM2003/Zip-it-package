import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig({
  plugins: [dts({ insertTypesEntry: true, rollupTypes: true })],
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ZipItReact',
      formats: ['es', 'cjs'],
      fileName: (format) => `index.${format === 'es' ? 'js' : 'cjs'}`,
    },
    rollupOptions: {
      external: ['react', 'react/jsx-runtime', '@blueneon/zip-it'],
      output: {
        globals: { react: 'React', '@blueneon/zip-it': 'ZipItCore' },
      },
    },
    target: 'ES2022',
    sourcemap: true,
  },
});
