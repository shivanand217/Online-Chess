// tsup bundler config: bundles this app + its @chess/* workspace deps into dist/ for production images. Hand-written.
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: true,
  noExternal: [/^@chess\//],
});
