/**
 * Model-facing browser tools registered with the harness tool registry.
 * Every tool operates on the shared {@link BrowserService} and returns a clear
 * error when Chrome is not open, so the model can recover by running `/chrome`
 * or calling `browser_open`.
 * @module dsh-chrome/tools
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Locator, Page } from 'playwright-core'
import { BrowserService } from './browser.ts'

/** Shared locator inputs: exactly one of these identifies the target element. */
interface TargetArgs {
  ref?: string
  text?: string
  selector?: string
}

/** Normalize a model-supplied snapshot ref (`e2`, `[ref=e2]`, or `ref=e2`). */
function normalizeRef(raw: string): string {
  return raw.trim().replace(/^\[?ref=/u, '').replace(/\]$/u, '')
}

function resolveLocator(page: Page, args: TargetArgs): Locator {
  const given = [args.ref, args.text, args.selector].filter((value) => value !== undefined && value !== '')
  if (given.length !== 1) throw new Error('specify exactly one of: ref, text, or selector')
  if (args.ref !== undefined && args.ref !== '') return page.locator(`aria-ref=${normalizeRef(args.ref)}`)
  if (args.text !== undefined && args.text !== '') return page.getByText(args.text, { exact: true })
  return page.locator(args.selector!)
}

const textRender = (_args: unknown, value: string): { type: 'text'; text: string }[] => [
  { type: 'text', text: value },
]

/**
 * Abort-aware delay for `browser_wait_for`: Playwright waits do not accept an
 * AbortSignal, but a plain timer can be cancelled cooperatively.
 */
function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      try {
        signal.throwIfAborted()
      } catch (error) {
        reject(error)
      }
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Register every browser_* tool. */
export function registerChromeTools(ctx: Context, browser: BrowserService): void {
  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open Chrome (launch or connect via CDP) so other browser tools can control it.',
    parameters: {
      url: { type: 'string', description: 'Optional URL to navigate to once open.' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.open()
      if (args.url !== undefined && args.url !== '') {
        await page.goto(browser.normalizeUrl(args.url), { waitUntil: 'domcontentloaded' })
      }
      return `Chrome is open at ${page.url()}. Use browser_snapshot to inspect the page.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_navigate',
    description: 'Navigate the current tab to a URL.',
    parameters: {
      url: { type: 'string', required: true, description: 'Full URL or bare domain (https:// is added).' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      await page.goto(browser.normalizeUrl(args.url), { waitUntil: 'domcontentloaded' })
      return `Navigated to ${page.url()}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_snapshot',
    description: 'Capture the accessibility tree of the current page as text with clickable element refs. This is the primary way to read a page.',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      const snapshot = await page.locator('body').ariaSnapshot({ mode: 'ai' }).catch(() => null)
      if (snapshot === null || snapshot === '') {
        return `Snapshot unavailable (URL: ${page.url()}). The page may be blank or still loading.`
      }
      return snapshot
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_click',
    description: 'Click an element identified by its snapshot ref, accessible text, or a CSS selector.',
    parameters: {
      ref: { type: 'string', description: 'Element ref from browser_snapshot (e.g. e2).' },
      text: { type: 'string', description: 'Exact accessible text of the element.' },
      selector: { type: 'string', description: 'CSS selector.' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      await resolveLocator(page, args).first().click()
      return `Clicked. URL: ${page.url()}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_type',
    description: 'Type text into an element (field or contenteditable).',
    parameters: {
      ref: { type: 'string' },
      text: { type: 'string' },
      selector: { type: 'string' },
      keys: { type: 'string', required: true, description: 'Text to type, char by char.' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      await resolveLocator(page, args).first().pressSequentially(args.keys)
      return `Typed ${args.keys.length} character(s).`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_fill',
    description: 'Fill an input/textarea/select with a value, replacing its current content.',
    parameters: {
      ref: { type: 'string' },
      text: { type: 'string' },
      selector: { type: 'string' },
      value: { type: 'string', required: true, description: 'Value to fill.' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      await resolveLocator(page, args).first().fill(args.value)
      return `Filled the field.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_press_key',
    description: 'Press a keyboard key or shortcut on the page (e.g. Enter, Escape, Control+a).',
    parameters: {
      key: { type: 'string', required: true, description: 'Key name or combo (Playwright keyboard.press syntax).' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      await page.keyboard.press(args.key)
      return `Pressed ${args.key}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the current page and save it under ~/.dsh/chrome-screenshots.',
    parameters: {
      name: { type: 'string', description: 'Optional base filename (without .png).' },
      fullPage: { type: 'boolean', description: 'Capture the full scrollable page.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          width: { type: 'number', required: true },
          height: { type: 'number', required: true },
          bytes: { type: 'number', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Screenshot saved to ${value.path} (${value.width}x${value.height}, ${value.bytes} bytes). Use browser_snapshot for a text view of the page.`,
      }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      const buffer = await page.screenshot({ type: 'png', fullPage: args.fullPage ?? false })
      const dir = join(homedir(), '.dsh', 'chrome-screenshots')
      await mkdir(dir, { recursive: true })
      const base = args.name !== undefined && args.name.trim() !== ''
        ? args.name.trim().replace(/[^a-zA-Z0-9._-]/gu, '_')
        : `shot-${Date.now()}`
      const file = base.endsWith('.png') ? base : `${base}.png`
      const path = join(dir, file)
      await writeFile(path, buffer)
      // PNG header: 8-byte signature + IHDR length (4) + "IHDR" (4), then
      // width/height as big-endian uint32. Read the real image size so
      // full-page captures do not report the viewport dimensions.
      const width = buffer.length >= 24 ? buffer.readUInt32BE(16) : 0
      const height = buffer.length >= 24 ? buffer.readUInt32BE(20) : 0
      return { path, width, height, bytes: buffer.length }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_wait_for',
    description: 'Wait for a fixed time or until visible text appears on the page.',
    parameters: {
      text: { type: 'string', description: 'Wait until this exact text is visible.' },
      ms: { type: 'number', description: 'Wait this many milliseconds.' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      if (args.text !== undefined && args.text !== '') {
        await page.getByText(args.text, { exact: true }).first().waitFor({ state: 'visible' })
        return `Text "${args.text}" is now visible.`
      }
      const ms = args.ms ?? 1000
      await abortableDelay(ms, exec.signal)
      return `Waited ${ms}ms.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_evaluate',
    description: 'Evaluate JavaScript in the page and return the JSON-serialized result.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JS expression (e.g. document.title) or statements with an explicit return.' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      const outcome = await page.evaluate((source: string): { ok: boolean; text: string } => {
        try {
          // Prefer the expression form (its value is the result); when it
          // does not parse — e.g. statements with ';' — treat the input as a
          // function body, where an explicit return provides the value.
          // Construction is separate from invocation so a SyntaxError thrown
          // by the page code itself does not trigger a bogus retry.
          let fn: () => unknown
          try {
            fn = Function(`"use strict"; return (${source})`) as () => unknown
          } catch {
            fn = Function(`"use strict"; ${source}`) as () => unknown
          }
          const value = fn()
          if (value === undefined) return { ok: true, text: 'undefined' }
          let serialized: string
          try {
            serialized = JSON.stringify(value)
          } catch {
            serialized = String(value)
          }
          return { ok: true, text: serialized === undefined ? 'undefined' : serialized }
        } catch (error) {
          return { ok: false, text: error instanceof Error ? error.message : String(error) }
        }
      }, args.expression)
      return outcome.ok ? outcome.text : `Error: ${outcome.text}`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_go',
    description: 'Navigate history: go back, forward, or reload the current tab.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'One of: back, forward, reload.',
        enum: ['back', 'forward', 'reload'],
      },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const page = await browser.ensure()
      if (args.action === 'back') await page.goBack()
      else if (args.action === 'forward') await page.goForward()
      else await page.reload()
      return `Done. URL: ${page.url()}.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_tabs',
    description: 'List, open, close, or switch browser tabs.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'One of: list, new, close, switch.',
        enum: ['list', 'new', 'close', 'switch'],
      },
      url: { type: 'string', description: 'URL for the new tab (action: new).' },
      index: { type: 'number', description: 'Zero-based tab index (actions: close, switch).' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      if (args.action === 'new') {
        const page = await browser.newPage(args.url)
        return `Opened tab ${browser.pages().indexOf(page)}: ${page.url()}.`
      }
      if (args.action === 'close') {
        await browser.closePage(args.index)
        return 'Closed the tab.'
      }
      if (args.action === 'switch') {
        if (args.index === undefined) {
          throw new Error('browser_tabs switch requires the index parameter (run browser_tabs list first).')
        }
        const page = await browser.switchToPage(args.index)
        return `Switched to tab ${args.index}: ${page.url()}.`
      }
      browser.assertOpen()
      const current = browser.activePage()
      const lines = await Promise.all(browser.pages().map(async (page, index) => {
        const marker = page === current ? '*' : ' '
        // page.title() is async: awaiting also turns closed-page failures
        // into an empty title instead of an unhandled rejection.
        const title = await page.title().catch(() => '')
        return `${marker}[${index}] ${title} — ${page.url()}`
      }))
      return lines.length === 0 ? 'No tabs open.' : lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_console',
    description: 'Return recent browser console messages from the current session.',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      await browser.ensure()
      const lines = browser.console().slice(-50)
      return lines.length === 0 ? 'No console messages captured.' : lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_network',
    description: 'Return recent network requests and their status codes from the current session.',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      await browser.ensure()
      const lines = browser.network().slice(-50)
      return lines.length === 0 ? 'No network requests captured.' : lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_close',
    description: 'Close the Chrome session.',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute(_args, exec) {
      exec.signal.throwIfAborted()
      await browser.close()
      return 'Chrome closed.'
    },
  }))
}
