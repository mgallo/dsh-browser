/**
 * dsh-browser plugin: a `/browser` slash command plus a set of browser_* tools
 * that control a dedicated web browser (Google Chrome by default) over CDP,
 * mirroring the `/chrome` experience of Claude Code.
 *
 * The plugin is host-only (Node): it launches or attaches to a browser with
 * Playwright and registers model-facing tools whose schemas flow into the
 * system prompt automatically.
 * @module dsh-browser
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { BrowserService, browserAliases, resolveBrowserAlias, type BrowserSpec } from './browser.ts'
import { Config } from './config.ts'
import { registerBrowserTools } from './tools.ts'

export const name = 'dsh-browser'

export const inject = ['tools', 'commands']

export function apply(ctx: Context, config: Config): void {
  const browser = new BrowserService(ctx, config)

  ctx.commands.register({
    name: 'browser',
    description: `Open a browser and browse the web: /browser [browser] [url] (browser: ${browserAliases().join(', ')})`,
    input: { hint: '[browser] [url]' },
    handler: async ({ agent, rawInput }): Promise<CommandResult> => {
      const { spec, url } = parseBrowserInput(rawInput)
      try {
        // No browser argument → fall back to the configured default (Chrome).
        const page = spec !== null ? await browser.open(spec) : await browser.openDefault()
        if (url !== '') await page.goto(browser.normalizeUrl(url), { waitUntil: 'domcontentloaded' })
        const current = page.url()
        agent.steer(createUserMessage({
          content: [{
            type: 'text',
            text: url !== ''
              ? `${browser.label} is open at ${current}. Inspect and interact with the page using the browser_* tools (start with browser_snapshot).`
              : `${browser.label} is open. Use the browser_* tools to navigate and interact with the web.`,
          }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: `${browser.label} is open at ${current}.` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  registerBrowserTools(ctx, browser)
}

/**
 * Split raw slash-command input into an optional leading browser alias and the
 * remaining URL. When the first token is not a known alias, the whole input is
 * treated as the URL (so `/browser example.com` still works and falls back to
 * the default browser).
 */
function parseBrowserInput(raw: string): { spec: BrowserSpec | null; url: string } {
  const tokens = raw.trim().split(/\s+/u).filter((t) => t !== '')
  if (tokens.length === 0) return { spec: null, url: '' }
  const first = tokens[0]!.toLowerCase()
  const spec = resolveBrowserAlias(first)
  if (spec !== null) return { spec, url: tokens.slice(1).join(' ') }
  return { spec: null, url: tokens.join(' ') }
}

export { Config }
