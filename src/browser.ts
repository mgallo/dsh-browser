/**
 * Playwright/CDP browser session: launch a dedicated Chrome or attach to a
 * running one, and expose the active page plus tab/console/network state to
 * the tool layer. The owning plugin's fiber closes the browser on unload.
 * @module dsh-chrome/browser
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core'
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './config.ts'

/** Bounded history lengths for the debug collectors. */
const MAX_CONSOLE = 200
const MAX_NETWORK = 200
/** Per-entry size cap so one noisy page cannot flood the collectors. */
const MAX_ENTRY = 500

function truncate(text: string): string {
  return text.length > MAX_ENTRY ? `${text.slice(0, MAX_ENTRY)}…` : text
}

/** Local dev servers are almost always plain HTTP. */
function isLocalHost(url: string): boolean {
  const host = (url.split(/[/?#]/u, 1)[0] ?? '')
    .replace(/:\d+$/u, '')
    .replace(/^\[|\]$/gu, '')
    .toLowerCase()
  return host === 'localhost'
    || host === '::1'
    || host.endsWith('.localhost')
    || host.endsWith('.local')
    || host.startsWith('127.')
}

export class BrowserService {
  private browser: Browser | null = null
  private context: BrowserContext | null = null
  private currentPage: Page | null = null
  private opening: Promise<Page> | null = null
  private readonly wiredPages = new WeakSet<Page>()
  private readonly consoleMessages: string[] = []
  private readonly networkLog: string[] = []

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    ctx.effect(() => () => this.close())
  }

  get isOpen(): boolean {
    return this.context !== null
  }

  /** Open (launch or connect) the browser and return the active page. */
  async open(): Promise<Page> {
    if (this.context !== null) return this.requirePage()
    // Guard against concurrent openers (e.g. /chrome plus an auto-launching
    // tool in the same turn): a second launch on the same userDataDir fails
    // with "profile in use".
    this.opening ??= this.doOpen().finally(() => {
      this.opening = null
    })
    return this.opening
  }

  private async doOpen(): Promise<Page> {
    let context: BrowserContext
    if (this.config.connectEndpoint !== '') {
      const browser = await chromium.connectOverCDP(this.config.connectEndpoint)
      const existing = browser.contexts()[0]
      if (existing === undefined) {
        throw new Error('connected to Chrome over CDP but found no browser context')
      }
      this.browser = browser
      context = existing
    } else {
      const userDataDir = this.config.userDataDir !== ''
        ? this.config.userDataDir
        : join(homedir(), '.dsh', 'chrome-profile')
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: this.config.channel,
        headless: this.config.headless,
        ...(this.config.executablePath !== '' ? { executablePath: this.config.executablePath } : {}),
        viewport: this.config.viewport,
        timeout: this.config.timeoutMs,
      })
      this.browser = context.browser()
    }
    this.context = context
    context.setDefaultTimeout(this.config.timeoutMs)
    context.setDefaultNavigationTimeout(this.config.timeoutMs)

    // Wire every existing page plus any page created later (popups via
    // target=_blank, tabs the user opens in attach mode), so console/network
    // collection and close bookkeeping cover the whole context.
    context.on('page', (page) => this.wirePage(page))
    for (const page of context.pages()) this.wirePage(page)

    const pages = context.pages()
    this.currentPage = pages.length > 0 ? pages[pages.length - 1]! : await context.newPage()
    return this.currentPage
  }

  /**
   * Return the active page, auto-launching when allowed. Throws a
   * model-recoverable message when the browser is closed.
   */
  async ensure(): Promise<Page> {
    if (this.context !== null) return this.requirePage()
    if (this.config.autoLaunch) return this.open()
    throw new Error('Chrome is not open. Run /chrome or call the browser_open tool first.')
  }

  /** Throw the standard model-recoverable error unless the browser is open. */
  assertOpen(): void {
    if (this.context === null) {
      throw new Error('Chrome is not open. Run /chrome or call the browser_open tool first.')
    }
  }

  /** The active page; throws when closed. */
  page(): Page {
    if (this.currentPage === null || this.currentPage.isClosed()) {
      throw new Error('Chrome is not open. Run /chrome or call the browser_open tool first.')
    }
    return this.currentPage
  }

  /** The active page, falling back to the last open tab; null when none. */
  activePage(): Page | null {
    if (this.currentPage !== null && !this.currentPage.isClosed()) return this.currentPage
    const pages = this.pages()
    return pages.length > 0 ? pages[pages.length - 1]! : null
  }

  pages(): Page[] {
    return this.context?.pages() ?? []
  }

  async newPage(url?: string): Promise<Page> {
    if (this.context === null) {
      if (!this.config.autoLaunch) this.assertOpen()
      await this.open()
    }
    const context = this.context!
    const page = await context.newPage()
    this.wirePage(page)
    if (url !== undefined && url !== '') await page.goto(this.normalizeUrl(url))
    this.currentPage = page
    return page
  }

  async switchToPage(index: number): Promise<Page> {
    const pages = this.pages()
    const page = pages[index]
    if (page === undefined) throw new Error(`no tab at index ${index} (${pages.length} tab(s) open)`)
    this.currentPage = page
    await page.bringToFront().catch(() => {})
    return page
  }

  async closePage(index?: number): Promise<void> {
    this.assertOpen()
    const pages = this.pages()
    const target = index === undefined
      ? this.requirePage()
      : pages[index]
    if (target === undefined) throw new Error(`no tab at index ${index} (${pages.length} tab(s) open)`)
    await target.close()
    if (this.currentPage === target) {
      const remaining = this.pages()
      this.currentPage = remaining.length > 0 ? remaining[remaining.length - 1]! : null
    }
  }

  async close(): Promise<void> {
    const context = this.context
    const browser = this.browser
    this.context = null
    this.currentPage = null
    this.browser = null
    this.consoleMessages.length = 0
    this.networkLog.length = 0
    // Closing the persistent context (or CDP connection) shuts the session down.
    await context?.close().catch(() => {})
    await browser?.close().catch(() => {})
  }

  console(): string[] {
    return this.consoleMessages
  }

  network(): string[] {
    return this.networkLog
  }

  normalizeUrl(url: string): string {
    if (/^https?:\/\//u.test(url)) return url
    return `${isLocalHost(url) ? 'http' : 'https'}://${url}`
  }

  private requirePage(): Page {
    const pages = this.pages()
    if (this.currentPage !== null && !this.currentPage.isClosed()) return this.currentPage
    if (pages.length > 0) {
      this.currentPage = pages[pages.length - 1]!
      return this.currentPage
    }
    throw new Error('no pages are open in Chrome')
  }

  private wirePage(page: Page): void {
    // Pages arrive from both explicit wiring and the context 'page' event.
    if (this.wiredPages.has(page)) return
    this.wiredPages.add(page)
    page.on('close', () => {
      if (this.currentPage === page) {
        const remaining = this.pages()
        this.currentPage = remaining.length > 0 ? remaining[remaining.length - 1]! : null
      }
    })
    page.on('console', (message) => {
      this.consoleMessages.push(truncate(`[${message.type()}] ${message.text()}`))
      if (this.consoleMessages.length > MAX_CONSOLE) this.consoleMessages.shift()
    })
    page.on('response', (response) => {
      const request = response.request()
      this.networkLog.push(truncate(`${request.method()} ${response.url()} -> ${response.status()}`))
      if (this.networkLog.length > MAX_NETWORK) this.networkLog.shift()
    })
    page.on('requestfailed', (request) => {
      this.networkLog.push(truncate(`${request.method()} ${request.url()} -> FAILED ${request.failure()?.errorText ?? ''}`))
      if (this.networkLog.length > MAX_NETWORK) this.networkLog.shift()
    })
  }
}
