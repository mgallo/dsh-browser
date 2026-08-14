# dsh-browser

Browser control for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a `/browser` slash command plus a set of `browser_*` tools, mirroring the `/chrome` experience of Claude Code.

The agent drives a **dedicated web browser through `playwright-core`** — **Google Chrome by default**, but any Chromium, Firefox, or WebKit browser via config. It can inspect pages (accessibility snapshot), click/type/navigate, take screenshots, and read console/network output.

## How it works

- **`/browser [browser] [url]`** launches the configured browser — or a specific one given as the first argument (e.g. `edge`, `firefox`) — optionally navigates to `url`, and wakes the agent so it can continue with the browser tools.
- **`browser_*` tools** are registered at plugin load and operate on the shared browser session. If the browser is not open, they auto-launch it (configurable) or return a recoverable hint.
- The primary model interface is the **accessibility snapshot** (`browser_snapshot`), a YAML-like text tree with clickable element refs (`[ref=e2]`). This matters because DeepSeek models are text-only; screenshots are saved to disk for the human to view.
- A browser **extension is not required** for this v1. It would only be needed to drive the user's *existing* browser session (their open tabs/log-ins); see [Roadmap](#roadmap).

## Requirements

- Node.js 24+.
- A DeepSeek Harness installation or source checkout.
- At least one browser. With no configuration, the plugin uses the installed **Google Chrome** (`channel: 'chrome'`). For other browsers, configure `browserType` / `channel` / `executablePath` (see [Configuration](#configuration)).

## Install

`dsh web` is a fixed alias for `--profile web` (the GUI profile), and a custom
profile initialised with `dsh plugin --profile <name> add …` only contains the
base bundles — not the web app. So the browser plugin goes **into the `web`
profile** to get the GUI plus the browser tools:

```sh
dsh plugin --profile web add ./path/to/dsh-browser
dsh web
```

From a source checkout of the harness, the same commands use `pnpm dsh`:

```sh
pnpm dsh plugin --profile web add /path/to/dsh-browser
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
pnpm dsh web --patch /path/to/dsh-browser/dev.patch.yml
```

`dev.patch.yml` is gitignored: copy `dev.patch.yml.example` and set the
absolute path of your checkout (the loader does not rebase patch paths).

## Usage

In the Web UI, type:

```
/browser https://example.com
```

To open a specific browser, put its alias first:

```
/browser edge https://example.com
/browser firefox https://example.com
/browser chrome
```

Supported aliases: `chrome`, `chromium`, `edge` / `msedge`, `firefox`, `webkit`. Omitting the alias uses the configured default (Chrome). Browsers that need an `executablePath` (e.g. Brave) are configured, not passed to the shortcut. Switching browsers closes the current one and reopens it in a per-browser profile (`~/.dsh/browser-profile/<browser>`).

Then prompt the agent normally; it can call `browser_snapshot`, `browser_click`, `browser_type`, `browser_navigate`, etc.

### Tools

| Tool | Purpose |
| --- | --- |
| `browser_open` | Launch/connect the browser (optional URL). |
| `browser_navigate` | Go to a URL. |
| `browser_snapshot` | Accessibility tree as text, with clickable `ref`s. |
| `browser_click` | Click by `ref`, exact `text`, or CSS `selector`. |
| `browser_type` | Type characters into an element. |
| `browser_fill` | Replace an input's value. |
| `browser_press_key` | Press a key/combo (`Enter`, `Control+a`, …). |
| `browser_screenshot` | Save a PNG under `~/.dsh/browser-screenshots`. |
| `browser_wait_for` | Wait `ms` or until `text` is visible. |
| `browser_evaluate` | Evaluate a JS expression and return JSON. |
| `browser_go` | `back` / `forward` / `reload`. |
| `browser_tabs` | `list` / `new` / `close` / `switch`. |
| `browser_console` | Recent console messages. |
| `browser_network` | Recent requests + status codes. |
| `browser_close` | Close the session. |

## Configuration

Set in `cordis.patch.yml` under the `browser` row (all fields have defaults):

| Field | Default | Description |
| --- | --- | --- |
| `browserType` | `chromium` | Engine family: `chromium`, `firefox`, or `webkit`. |
| `channel` | `''` | Playwright channel (`chrome`, `msedge`, `chromium`, `firefox`, …). Empty selects the engine default — **system Google Chrome for `chromium`**. |
| `headless` | `false` | Run without a visible window. |
| `executablePath` | `''` | Absolute browser binary path; empty = channel default. |
| `userDataDir` | `''` | Persistent profile dir; empty = `~/.dsh/browser-profile/<browser>`. |
| `connectEndpoint` | `''` | Attach to a running **Chromium** via CDP (e.g. `http://127.0.0.1:9222`) instead of launching. |
| `autoLaunch` | `true` | Tools auto-launch the browser when none is open. |
| `viewport` | `{ width: 1280, height: 800 }` | New-context viewport. |
| `timeoutMs` | `15000` | Default action timeout. |

**Chrome is the fallback**: with `browserType: chromium` and no `channel`/`executablePath`, the plugin launches the installed Google Chrome.

### Microsoft Edge

```yaml
- insert:
    - id: browser
      name: dsh-browser
      config:
        browserType: chromium
        channel: msedge
```

### Firefox

Use your system Firefox via `executablePath`, or install Playwright's Firefox
and use `channel: firefox`:

```yaml
- insert:
    - id: browser
      name: dsh-browser
      config:
        browserType: firefox
        executablePath: /Applications/Firefox.app/Contents/MacOS/firefox
```

### WebKit / Safari

```yaml
- insert:
    - id: browser
      name: dsh-browser
      config:
        browserType: webkit
        executablePath: /path/to/WebKit
```

> **Note:** `playwright-core` ships no bundled browsers. The `chrome`/`msedge`
> channels use your system browser; `chromium`/`firefox`/`webkit` channels
> require Playwright's bundled browsers (`npx playwright install`) or an
> `executablePath`.

### Attach to a running Chromium

```yaml
- insert:
    - id: browser
      name: dsh-browser
      config:
        connectEndpoint: 'http://127.0.0.1:9222'
```

CDP attach is Chromium-only; set `connectEndpoint` with `browserType` other
than `chromium` and the plugin fails with a clear error.

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
- Browser extension + native messaging to drive the user's *existing* browser session (their open tabs and log-ins).
- A `browser_*` tool for drag/scroll and file upload.

## License

MIT
