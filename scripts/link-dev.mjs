#!/usr/bin/env node
/**
 * Link the in-box `@deepseek-ai/*` packages, `playwright-core`, and Node types
 * from a local deepseek-harness checkout into this package's `node_modules`,
 * so `pnpm typecheck` and `pnpm build` work without publishing anything.
 *
 * Usage:  node scripts/link-dev.mjs /path/to/deepseek-harness
 *         node --env-file=.env scripts/link-dev.mjs   (DSH_HARNESS_CHECKOUT)
 *         (fallback: ../deepseek-harness)
 */
import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const harness = resolve(
  process.argv[2] ?? process.env.DSH_HARNESS_CHECKOUT ?? join(root, '..', 'deepseek-harness'),
)

if (!existsSync(harness)) {
  console.error(`Harness checkout not found at ${harness}.`)
  console.error('Pass it explicitly (node scripts/link-dev.mjs /path/to/deepseek-harness),')
  console.error('or set DSH_HARNESS_CHECKOUT in .env and use `node --env-file=.env`.')
  process.exit(1)
}

const links = {
  '@deepseek-ai/cordis': 'vendor/cordis',
  '@deepseek-ai/schemastery': 'vendor/schemastery',
  '@deepseek-ai/dsh-tools': 'packages/core/tools',
  '@deepseek-ai/dsh-commands': 'packages/interaction/commands',
  '@deepseek-ai/dsh-agent': 'packages/core/agent',
  '@deepseek-ai/dsh-llm': 'packages/llm/llm',
  '@deepseek-ai/dsh-attachment': 'packages/attachment/attachment',
}

function link(name, target) {
  const dest = join(root, 'node_modules', ...name.split('/'))
  const resolved = resolve(harness, target)
  mkdirSync(dirname(dest), { recursive: true })
  try {
    if (readlinkSync(dest) === resolved) return
    rmSync(dest, { recursive: true, force: true })
  } catch { /* not a link yet */ }
  symlinkSync(resolved, dest, 'junction')
  console.log(`linked ${name} -> ${resolved}`)
}

for (const [name, target] of Object.entries(links)) link(name, target)

// playwright-core, @types/node, tsdown, and typescript live in pnpm's isolated
// store; resolve any installed version by scanning the store directory names.
const pnpmStore = join(harness, 'node_modules', '.pnpm')
if (!existsSync(pnpmStore)) {
  console.error(`No pnpm store at ${pnpmStore}.`)
  console.error('Run `pnpm install` in the harness checkout first.')
  process.exit(1)
}
const storeEntries = readdirSync(pnpmStore)

const pwDir = storeEntries.find(name => name.startsWith('playwright-core@'))
if (pwDir !== undefined) link('playwright-core', join(pnpmStore, pwDir, 'node_modules', 'playwright-core'))

const nodeTypesDir = storeEntries.find(name => name.startsWith('@types+node@'))
if (nodeTypesDir !== undefined) link('@types/node', join(pnpmStore, nodeTypesDir, 'node_modules', '@types', 'node'))

const tsdownDir = storeEntries.find(name => name.startsWith('tsdown@'))
if (tsdownDir !== undefined) link('tsdown', join(pnpmStore, tsdownDir, 'node_modules', 'tsdown'))

const typescriptDir = storeEntries.find(name => name.startsWith('typescript@'))
if (typescriptDir !== undefined) link('typescript', join(pnpmStore, typescriptDir, 'node_modules', 'typescript'))

console.log('Done. Run `pnpm typecheck` or `pnpm build`.')
