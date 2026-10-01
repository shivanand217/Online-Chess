import { defineConfig } from 'tsup';

// Bundle the app + its workspace deps into a self-contained ESM file so the runtime image needs no
// node_modules. The banner shims `require` because some bundled CJS deps (pino) call it at runtime.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
