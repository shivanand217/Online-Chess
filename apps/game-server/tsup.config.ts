// tsup bundler config: bundles this app + its @chess/* workspace deps into dist/ for production images. Hand-written.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  // Produce a fully self-contained bundle (workspace + third-party) so the runtime image needs no
  // node_modules at all. The banner shims `require` because bundled CJS deps (pino) call it at runtime.
  noExternal: [/.*/],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
});
