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
  if (args.ref !== undefined && args.ref !== '') return page.locator(`aria-ref=${normalizeRef(args.ref)}`)
  if (args.text !== undefined && args.text !== '') return page.getByText(args.text, { exact: true })
  if (args.selector !== undefined && args.selector !== '') return page.locator(args.selector)
  throw new Error('specify exactly one of: ref, text, or selector')
}

const textRender = (_args: unknown, value: string): { type: 'text'; text: string }[] => [
  { type: 'text', text: value },
]

/** Register every browser_* tool. */
export function registerChromeTools(ctx: Context, browser: BrowserService): void {
  ctx.tools.register(defineTool({
    name: 'browser_open',
    description: 'Open Chrome (launch or connect via CDP) so other browser tools can control it.',
    parameters: {
      url: { type: 'string', description: 'Optional URL to navigate to once open.' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const page = await browser.open()
      if (args.url !== undefined && args.url !== '') await page.goto(browser.normalizeUrl(args.url))
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
    async execute(args) {
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
    async execute() {
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
    async execute(args) {
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
    async execute(args) {
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
      selector: { type: 'string' },
      value: { type: 'string', required: true, description: 'Value to fill.' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
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
    async execute(args) {
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
    async execute(args) {
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
      const size = page.viewportSize()
      return { path, width: size?.width ?? 0, height: size?.height ?? 0, bytes: buffer.length }
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
    async execute(args) {
      const page = await browser.ensure()
      if (args.text !== undefined && args.text !== '') {
        await page.getByText(args.text, { exact: true }).first().waitFor({ state: 'visible' })
        return `Text "${args.text}" is now visible.`
      }
      const ms = args.ms ?? 1000
      await page.waitForTimeout(ms)
      return `Waited ${ms}ms.`
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_evaluate',
    description: 'Evaluate a JavaScript expression in the page and return the JSON-serialized result.',
    parameters: {
      expression: { type: 'string', required: true, description: 'JS expression whose value is returned (e.g. document.title).' },
    },
    output: { schema: { type: 'string' }, render: textRender },
    async execute(args) {
      const page = await browser.ensure()
      const outcome = await page.evaluate((expression: string): { ok: boolean; text: string } => {
        try {
          const value = Function(`"use strict"; return (${expression})`)() as unknown
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
    async execute(args) {
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
    async execute(args) {
      if (args.action === 'new') {
        const page = await browser.newPage(args.url)
        return `Opened tab ${browser.pages().indexOf(page)}: ${page.url()}.`
      }
      if (args.action === 'close') {
        await browser.closePage(args.index)
        return 'Closed the tab.'
      }
      if (args.action === 'switch') {
        const page = await browser.switchToPage(args.index ?? 0)
        return `Switched to tab ${args.index ?? 0}: ${page.url()}.`
      }
      const current = browser.page()
      const lines = browser.pages().map((page, index) => {
        const marker = page === current ? '*' : ' '
        const title = page.title() ?? ''
        return `${marker}[${index}] ${title} — ${page.url()}`
      })
      return lines.length === 0 ? 'No tabs open.' : lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'browser_console',
    description: 'Return recent browser console messages from the current session.',
    parameters: {},
    output: { schema: { type: 'string' }, render: textRender },
    async execute() {
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
    async execute() {
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
    async execute() {
      await browser.close()
      return 'Chrome closed.'
    },
  }))
}
