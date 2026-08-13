# AGENTS.md — dsh-chrome

Guidance for AI agents working on this repository. Read this before changing
anything; it encodes the harness integration contract and the pitfalls that
were already paid for once.

## What this is

`dsh-chrome` is an out-of-tree **bundle plugin for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)**. It gives
a harness agent browser control the way Claude Code's `/chrome` does: a
`/chrome` slash command plus a set of model-facing `browser_*` tools.

- Runtime: a single Node ESM bundle (`lib/index.js`) produced by `tsdown`.
- Mechanism: `playwright-core` over the **Chrome DevTools Protocol (CDP)**.
  It launches the user's real Google Chrome (`chromium.launchPersistentContext`
  with `channel: 'chrome'`) or attaches to an already-running one via
  `connectOverCDP`.
- **No Chrome extension is needed.** An extension would only be required to
  drive the user's *existing* browser session (their open tabs / log-ins);
  that is deferred roadmap work.

Reference app used for the first end-to-end smoke test: a Tauri/Vite Chinese
flashcard app (`汉字墨卡`) served at `http://localhost:1420` (not part of this
repo).

## Layout

```
src/index.ts        apply(ctx, config): mounts BrowserService, registers /chrome + tools
src/browser.ts      BrowserService — Playwright/CDP lifecycle, tabs, console/network collectors
src/tools.ts        the 15 browser_* tool definitions (defineTool)
src/config.ts       Config interface + Schemastery schema (all fields have defaults)
cordis.patch.yml    bundle layer: inserts row `name: dsh-chrome` (the installed package)
dev.patch.yml       dev overlay (--patch flow); gitignored, copied from dev.patch.yml.example
tsconfig.json       typecheck config (moduleResolution: bundler; see "Typecheck")
tsdown.config.ts    build config (ESM bundle, externals kept external)
scripts/link-dev.mjs  symlinks harness packages + playwright-core into node_modules for dev
package.json        dsh.bundle manifest; playwright-core dependency; @deepseek-ai/* peers
```

## Harness plugin contract (must not break)

A harness plugin is a module with **named exports only** — the Loader's
`unwrapExports` requires `name`, `inject`, `Config`, and `apply`, and a default
export breaks it. Our bundle emits `export { Config, apply, inject, name }`
(verified: no `default`).

- `export const name = 'dsh-chrome'`
- `export const inject = ['tools', 'commands']` — the plugin stays PENDING until
  those services exist; order in `cordis.yml` does not matter.
- `export function apply(ctx, config)` — registers everything; registrations are
  effects and unwind automatically on unload. Explicit cleanup uses
  `ctx.effect(() => () => disposer)`.
- `export const Config: Schema<Config> = Schema.object({...})` — every field has
  a `.default()` so there are no "optional without default" fields (Schemastery
  has no `.optional()`; a missing schema field simply isn't populated).

### Tools

```ts
ctx.tools.register(defineTool({
  name, description,
  parameters: { url: { type: 'string', required: true, description } }, // input DSL
  output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
  async execute(args, exec) { ... }, // returns the canonical JSON value; honor exec.signal
}))
```

### Commands

```ts
ctx.commands.register({
  name: 'chrome', description, input: { hint: '[url]' },
  handler: async ({ agent, rawInput }): Promise<CommandResult> => { ... },
})
```

To make the agent act after a command, use `agent.steer(createUserMessage({...}))`
(from `@deepseek-ai/dsh-llm`) — this is what `dsh-plan-mode` does.

## Tool-schema DSL rules (learned the hard way)

- **Input** `parameters` use `ParameterSchemaSpec`: per-property `required: true`.
- **Output** `schema` uses `ValueSchemaSpec`. It does **NOT** accept an
  object-level `required: [...]` key — that throws
  `JsonSchemaError: schema.required is not supported by the value schema DSL`
  at tool-registration time. Requiredness in an output object is per-property
  `required: true` inside `properties`.
- Object nodes must set `additionalProperties: true | false` explicitly.
- Scalar `enum`/`const` are supported; exact-one unions use `oneOf`.
- Canonical `output.schema` should be a useful programmatic API (Code Mode binds
  to it); keep human prose in `output.render`.

## Why text-first snapshots

DeepSeek models are **text-only**. `browser_snapshot` returns
`page.locator('body').ariaSnapshot({ mode: 'ai' })` — a YAML-like accessibility
tree with element refs `[ref=eN]`. That text is the model's primary "eyes".
Screenshots are written to `~/.dsh/chrome-screenshots/` for the human; inline
image blocks (`ctx.attachments` → `ImageBlock`) are a future multimodal
enhancement.

Resolve a snapshot ref for click/type/fill with
`page.locator(\`aria-ref=${normalizeRef(ref)}\`)`, where `normalizeRef` accepts
`e2`, `[ref=e2]`, or `ref=e2`.

## Build / typecheck / test

```sh
# one-time: link harness deps + toolchain into node_modules
# (reads DSH_HARNESS_CHECKOUT from .env; or pass the harness path as argv)
node --env-file=.env scripts/link-dev.mjs

pnpm typecheck   # tsc --noEmit (resolves @deepseek-ai/* via the symlinks)
pnpm build       # tsdown -> lib/index.js + lib/index.d.ts
```

There is no `prepare` script on purpose: for a local `dsh plugin add ./path`,
pnpm links the checkout without the dev toolchain, and a build script would
fail. Build explicitly before installing/loading. (Add a self-contained
`prepare` only if you later distribute via git/npm.)

**Typecheck note.** The plugin resolves `@deepseek-ai/*`, `playwright-core`,
`@types/node`, `tsdown`, and `typescript` from the harness checkout through
symlinks in `node_modules/` (gitignored). `tsconfig.json` uses
`moduleResolution: bundler` + `allowImportingTsExtensions` + `skipLibCheck`
because the harness's built `.d.ts` files use `.ts`-extension relative imports.

**Smoke test without booting the GUI** (validates all `defineTool` schemas and
the command registration):

```sh
node --input-type=module -e "
import('./lib/index.js').then(async m => {
  const tools = [], commands = [];
  const ctx = {
    tools: { register: d => tools.push(d.name) },
    commands: { register: d => commands.push(d.name) },
    effect: () => () => {}, get: () => undefined,
    logger: { warn(){}, info(){} },
  };
  m.apply(ctx, m.Config({}));
  console.log(tools, commands);
})"
```

## Load into the harness

Two ways — both require a **restart** of the running `dsh web` process.

1. **Bundle (persistent).** Add the plugin to the GUI profile and boot it:

   ```sh
   dsh plugin --profile web add "$DSH_CHROME_CHECKOUT"
   dsh web
   ```

2. **`--patch` overlay (dev iteration):**

   ```sh
   pnpm dsh web --patch "$DSH_CHROME_CHECKOUT/dev.patch.yml"
   ```

## CLI / profile gotchas

- `dsh web` is a **hardcoded alias for `--profile web`**. The `web` subcommand
  accepts `--patch` / `--dump-config` / `--dump-default-config` but rejects
  parent flags — `dsh web --profile chrome` fails with
  `web takes none of parent --profile, --patch, ...`.
- A custom profile made with `dsh plugin --profile <name> add ...` contains only
  `@deepseek-ai/dsh-base` — **not** the web app (`@deepseek-ai/dsh-web-app`).
  To get the GUI + this plugin, add the plugin to the `web` profile, or stack
  the web-app bundle into the custom profile.
- Launcher flags come first; everything after them is handed to the booted app.

## Runtime resolution

- `@deepseek-ai/*` peers resolve from the harness installation via the healed
  `$DSH_HOME/profiles/node_modules` fallback (symlinks into the dsh dependency
  closure). Do not add them as `dependencies`.
- `playwright-core` is a real `dependency` (pinned), installed by pnpm into the
  profile. Use `playwright-core`, **not** `playwright`: no browser download, no
  postinstall, no pnpm `strictDepBuilds` friction. The browser is the system
  Chrome via `channel: 'chrome'`.

## Conventions

- Host-only (Node) plugin; no client/browser bundle.
- Keep tool names `browser_*`; keep the `/chrome` command name reserved for this
  plugin.
- Fail loudly and readably: tools throw messages the model can recover from
  ("Chrome is not open. Run /chrome or call the browser_open tool first.").
- Bounded collectors (console/network capped at 200 entries).

## Verification checklist for a change

1. `pnpm typecheck` clean.
2. `pnpm build` clean.
3. Smoke test above lists 15 tools + `/chrome`.
4. If the change touches tool schemas, the smoke test (which runs real
   `defineTool` compilation) must not throw.
5. Optional real check: load via `--patch`, then `browser_navigate` +
   `browser_snapshot` against any live URL.

## Roadmap

- Inline screenshots via `ctx.attachments` (`ImageBlock`) for multimodal models.
- Chrome extension + native messaging to control the user's existing session.
- More interactions (scroll/drag, file upload, dialog handling).

## Local machine paths

Checkout paths are machine-specific and live in **`.env`** (gitignored;
template: `.env.example`). Read it first — `source .env` in shell commands —
and use its variables wherever a command needs a checkout path:

- `DSH_CHROME_CHECKOUT` — this plugin checkout (the repo root).
- `DSH_HARNESS_CHECKOUT` — the deepseek-harness checkout; not owned by this
  repo, read-only reference for the harness API/docs. Also consumed by
  `scripts/link-dev.mjs` via `node --env-file=.env`.
- `dev.patch.yml` is likewise gitignored (it must embed an absolute path):
  copy `dev.patch.yml.example` and substitute this checkout's path.

Harness docs that define the plugin contract (under `$DSH_HARNESS_CHECKOUT`):
`docs/user/develop/basic/{index,tool,config,publish}.md`,
`docs/cookbook/adding-a-tool.md`, and
`packages/core/tools/README.md` + `packages/interaction/commands/README.md`.
