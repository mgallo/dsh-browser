import { defineConfig } from 'tsdown'

/**
 * Bundle the plugin into a single Node ESM entry (`lib/index.js`). In-box
 * peers and the browser driver stay external: at runtime the harness resolves
 * `@deepseek-ai/*` from the installation fallback and pnpm installs
 * `playwright-core` into the profile's node_modules.
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  // Keep `.js`/`.d.ts` extensions (package type is `module`) instead of `.mjs`.
  fixedExtension: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^node:/, 'playwright-core'],
  },
})
