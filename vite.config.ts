import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export default defineConfig(({ command }) => {
  // --- LIBRARY BUILD MODE ---
  if (command === 'build') {
    return {
      plugins: [
        dts({
          include: ['src'],
          // rollupTypes: true,          // Disable to ensure robust type generation
          tsconfigPath: './tsconfig.lib.json',
        }),
      ],
      build: {
        lib: {
          entry: resolve(__dirname, 'src/index.ts'),
          name: 'ZipIt',
          // Output both ES Module and CommonJS builds
          formats: ['es', 'cjs'],
          fileName: (format) => `zip-it.${format === 'es' ? 'mjs' : 'cjs'}`,
        },
        rollupOptions: {
          // Mark peer dependencies as external (consumers must provide them)
          external: ['streamsaver'],
          output: {
            globals: {
              streamsaver: 'streamSaver',
            },
          },
        },
        // Workers imported with `?worker&inline` are automatically inlined as base64 blobs
        worker: {
          format: 'es',
        },
        sourcemap: true,
        outDir: 'dist',
        emptyOutDir: true,
      },
    };
  }

  // --- DEV SERVER MODE (Demo App) ---
  return {
    root: './',
    server: {
      open: true,
    },
    worker: {
      format: 'es',
    },
    resolve: {
      alias: {
        // Allow the demo (main.ts) to import from the src directly for hot-reload dev
        '@blueneon/zip-it': resolve(__dirname, 'src/index.ts'),
      },
    },
  };
});
