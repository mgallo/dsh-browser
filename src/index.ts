/**
 * dsh-chrome plugin: a `/chrome` slash command plus a set of browser_* tools
 * that control a dedicated Google Chrome over CDP, mirroring the `/chrome`
 * experience of Claude Code.
 *
 * The plugin is host-only (Node): it launches or attaches to Chrome with
 * Playwright and registers model-facing tools whose schemas flow into the
 * system prompt automatically.
 * @module dsh-chrome
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { BrowserService } from './browser.ts'
import { Config } from './config.ts'
import { registerChromeTools } from './tools.ts'

export const name = 'dsh-chrome'

export const inject = ['tools', 'commands']

export function apply(ctx: Context, config: Config): void {
  const browser = new BrowserService(ctx, config)

  ctx.commands.register({
    name: 'chrome',
    description: 'Open Chrome and browse the web (optionally at a URL)',
    input: { hint: '[url]' },
    handler: async ({ agent, rawInput }): Promise<CommandResult> => {
      const url = rawInput.trim()
      try {
        const page = await browser.open()
        if (url !== '') await page.goto(browser.normalizeUrl(url))
        const current = page.url()
        agent.steer(createUserMessage({
          content: [{
            type: 'text',
            text: url !== ''
              ? `Chrome is open at ${current}. Inspect and interact with the page using the browser_* tools (start with browser_snapshot).`
              : 'Chrome is open. Use the browser_* tools to navigate and interact with the web.',
          }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: `Chrome is open at ${current}.` }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  registerChromeTools(ctx, browser)
}

export { Config }
