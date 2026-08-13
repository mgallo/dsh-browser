# dsh-chrome

Chrome browser control for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a `/chrome` slash command plus a set of `browser_*` tools, mirroring the `/chrome` experience of Claude Code.

The agent drives a **dedicated Google Chrome over the Chrome DevTools Protocol (CDP)** through `playwright-core`. It can inspect pages (accessibility snapshot), click/type/navigate, take screenshots, and read console/network output.

## How it works

- **`/chrome [url]`** launches Chrome (or attaches to a running one via CDP), optionally navigates to `url`, and wakes the agent so it can continue with the browser tools.
- **`browser_*` tools** are registered at plugin load and operate on the shared browser session. If Chrome is not open, they auto-launch it (configurable) or return a recoverable hint.
- The primary model interface is the **accessibility snapshot** (`browser_snapshot`), a YAML-like text tree with clickable element refs (`[ref=e2]`). This matters because DeepSeek models are text-only; screenshots are saved to disk for the human to view.
- A Chrome **extension is not required** for this v1. It would only be needed to drive the user's *existing* browser session (their open tabs/log-ins); see [Roadmap](#roadmap).

## Requirements

- Node.js 24+.
- A DeepSeek Harness installation or source checkout.
- Google Chrome installed (Playwright's `channel: 'chrome'` default). Optionally override with `executablePath` or another `channel`.

## Install

`dsh web` is a fixed alias for `--profile web` (the GUI profile), and a custom
profile initialised with `dsh plugin --profile <name> add …` only contains the
base bundles — not the web app. So the browser plugin goes **into the `web`
profile** to get the GUI plus the browser tools:

```sh
dsh plugin --profile web add ./path/to/dsh-chrome
dsh web
```

From a source checkout of the harness, the same commands use `pnpm dsh`:

```sh
pnpm dsh plugin --profile web add /path/to/dsh-chrome
pnpm dsh web
```

`pnpm build` must have produced `lib/` first (`dsh plugin add` links the
checkout and does not build it).

If you install from a git host instead, the package must ship built artifacts
or a self-contained `prepare` script (see the harness [publish guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)).

### Fast local-dev load (no install)

Build first, then load the built entry as a patch overlay on the web profile:

```sh
node scripts/link-dev.mjs /path/to/deepseek-harness
pnpm build
pnpm dsh web --patch /path/to/dsh-chrome/dev.patch.yml
```

`dev.patch.yml` is gitignored: copy `dev.patch.yml.example` and set the
absolute path of your checkout (the loader does not rebase patch paths).

## Usage

In the Web UI, type:

```
/chrome https://example.com
```

Then prompt the agent normally; it can call `browser_snapshot`, `browser_click`, `browser_type`, `browser_navigate`, etc.

### Tools

| Tool | Purpose |
| --- | --- |
| `browser_open` | Launch/connect Chrome (optional URL). |
| `browser_navigate` | Go to a URL. |
| `browser_snapshot` | Accessibility tree as text, with clickable `ref`s. |
| `browser_click` | Click by `ref`, exact `text`, or CSS `selector`. |
| `browser_type` | Type characters into an element. |
| `browser_fill` | Replace an input's value. |
| `browser_press_key` | Press a key/combo (`Enter`, `Control+a`, …). |
| `browser_screenshot` | Save a PNG under `~/.dsh/chrome-screenshots`. |
| `browser_wait_for` | Wait `ms` or until `text` is visible. |
| `browser_evaluate` | Evaluate a JS expression and return JSON. |
| `browser_go` | `back` / `forward` / `reload`. |
| `browser_tabs` | `list` / `new` / `close` / `switch`. |
| `browser_console` | Recent console messages. |
| `browser_network` | Recent requests + status codes. |
| `browser_close` | Close the session. |

## Configuration

Set in `cordis.patch.yml` under the `chrome` row (all fields have defaults):

| Field | Default | Description |
| --- | --- | --- |
| `channel` | `chrome` | Playwright browser channel (`chrome`, `msedge`, `chromium`…). |
| `headless` | `false` | Run without a visible window. |
| `executablePath` | `''` | Absolute browser binary path; empty = channel default. |
| `userDataDir` | `''` | Persistent profile dir; empty = `~/.dsh/chrome-profile`. |
| `connectEndpoint` | `''` | Attach to an existing Chrome via CDP (e.g. `http://127.0.0.1:9222`) instead of launching. |
| `autoLaunch` | `true` | Tools auto-launch Chrome when none is open. |
| `viewport` | `{ width: 1280, height: 800 }` | New-context viewport. |
| `timeoutMs` | `15000` | Default action timeout. |

Example: attach to a Chrome you started with `--remote-debugging-port=9222`:

```yaml
- insert:
    - id: chrome
      name: dsh-chrome
      config:
        connectEndpoint: 'http://127.0.0.1:9222'
```

## Development

```sh
# One-time: link the harness's in-box packages + playwright-core + toolchain
node scripts/link-dev.mjs /path/to/deepseek-harness

pnpm typecheck   # tsc --noEmit
pnpm build       # tsdown -> lib/index.js
```

The plugin is host-only (Node). `lib/index.js` is a single ESM bundle that leaves `@deepseek-ai/*`, `playwright-core`, and Node builtins external: the harness resolves in-box packages from the installation fallback, and `playwright-core` is installed by pnpm into the profile.

## Roadmap

- Inline screenshot rendering via `ctx.attachments` (`ImageBlock`) for multimodal models.
- Chrome extension + native messaging to drive the user's *existing* browser session (their open tabs and log-ins).
- A `browser_*` tool for drag/scroll and file upload.

## License

MIT
