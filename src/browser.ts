/**
 * Playwright browser session: launch a dedicated browser (Google Chrome by
 * default, or any Chromium/Firefox/WebKit engine) or attach to a running
 * Chromium over CDP, and expose the active page plus tab/console/network
 * state to the tool layer. The owning plugin's fiber closes the browser on
 * unload.
 * @module dsh-browser-driver/browser
 */

import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from 'playwright-core'
import type { Context } from '@deepseek-ai/cordis'
import type { BrowserEngine, Config } from './config.ts'

/** A concrete browser selection: engine + channel + optional binary path. */
export interface BrowserSpec {
  browserType: BrowserEngine
  channel: string
  executablePath: string
}

/** Browser engines selectable by `browserType`. */
const ENGINES: Record<BrowserEngine, BrowserType> = { chromium, firefox, webkit }

/** Friendly names for common browser executables (matched by basename). */
const EXECUTABLE_LABELS: Record<string, string> = {
  'Brave Browser': 'Brave',
  'Google Chrome': 'Chrome',
  Chromium: 'Chromium',
  'Microsoft Edge': 'Edge',
  Firefox: 'Firefox',
  firefox: 'Firefox',
  MiniBrowser: 'WebKit',
}

/** Friendly display names for the common Playwright channels. */
const CHANNEL_LABELS: Record<string, string> = {
  chrome: 'Chrome',
  'chrome-beta': 'Chrome Beta',
  'chrome-dev': 'Chrome Dev',
  'chrome-canary': 'Chrome Canary',
  msedge: 'Edge',
  'msedge-beta': 'Edge Beta',
  'msedge-dev': 'Edge Dev',
  'msedge-canary': 'Edge Canary',
  chromium: 'Chromium',
  firefox: 'Firefox',
  'firefox-beta': 'Firefox Beta',
  'firefox-dev': 'Firefox Dev',
  'firefox-nightly': 'Firefox Nightly',
  webkit: 'WebKit',
}

/**
 * Short aliases accepted by `/browser <browser>`, resolved to a spec. Channel
 * based only: browsers that require an `executablePath` (e.g. Brave) are set
 * in config, not the shortcut. Safari (Apple's app) is not drivable by
 * Playwright and has no alias.
 */
const BROWSER_ALIASES: Record<string, BrowserSpec> = {
  chrome: { browserType: 'chromium', channel: 'chrome', executablePath: '' },
  chromium: { browserType: 'chromium', channel: 'chromium', executablePath: '' },
  edge: { browserType: 'chromium', channel: 'msedge', executablePath: '' },
  msedge: { browserType: 'chromium', channel: 'msedge', executablePath: '' },
  firefox: { browserType: 'firefox', channel: '', executablePath: '' },
  webkit: { browserType: 'webkit', channel: '', executablePath: '' },
}

/** Resolve a `/browser` alias token (lowercase) to a spec, or null. */
export function resolveBrowserAlias(name: string): BrowserSpec | null {
  return BROWSER_ALIASES[name] ?? null
}

/** All accepted `/browser` alias tokens. */
export function browserAliases(): string[] {
  return Object.keys(BROWSER_ALIASES)
}

/** Resolve the effective Playwright channel; system Chrome is the default. */
function resolveChannel(spec: BrowserSpec): string | undefined {
  if (spec.channel !== '') return spec.channel
  return spec.browserType === 'chromium' ? 'chrome' : undefined
}

/** Human-readable name for a spec, e.g. "Chrome", "Edge", "Brave", "Firefox". */
function labelFor(spec: BrowserSpec): string {
  if (spec.executablePath !== '') {
    const base = basename(spec.executablePath).replace(/\.exe$/iu, '')
    return EXECUTABLE_LABELS[base] ?? base
  }
  const channel = spec.channel !== '' ? spec.channel : spec.browserType === 'chromium' ? 'chrome' : spec.browserType
  return CHANNEL_LABELS[channel] ?? CHANNEL_LABELS[spec.browserType] ?? 'Browser'
}

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
  private currentSpec: BrowserSpec | null = null
  private readonly wiredPages = new WeakSet<Page>()
  private readonly consoleMessages: string[] = []
  private readonly networkLog: string[] = []

  constructor(
    ctx: Context,
    private readonly config: Config,
  ) {
    ctx.effect(() => () => this.close())
  }

  /** Human-readable name of the current browser (or the configured default). */
  get label(): string {
    return labelFor(this.currentSpec ?? this.baseSpec())
  }

  get isOpen(): boolean {
    return this.context !== null
  }

  /** Open (launch or connect) the browser and return the active page. */
  async open(override?: Partial<BrowserSpec>): Promise<Page> {
    if (this.context !== null) {
      // No explicit override (e.g. a browser_* tool): reuse whichever browser
      // is already open rather than falling back to the configured default.
      if (override === undefined) return this.requirePage()
      const requested = this.resolveSpec(override)
      // Same browser already open: reuse it. Switching browsers closes the
      // current one first (a session holds exactly one browser, and distinct
      // browsers must not share a user-data dir).
      if (this.specKey(requested) === this.specKey(this.currentSpec!)) return this.requirePage()
      await this.close()
    }
    const spec = this.resolveSpec(override)
    // Guard against concurrent openers (e.g. /browser plus an auto-launching
    // tool in the same turn): a second launch on the same userDataDir fails
    // with "profile in use".
    this.opening ??= this.doOpen(spec).finally(() => {
      this.opening = null
    })
    return this.opening
  }

  /**
   * Open the configured default browser, switching away from any other open
   * browser. This is what `/browser` does when no browser argument is given:
   * fall back to the default (Chrome, unless configured otherwise).
   */
  async openDefault(): Promise<Page> {
    return this.open(this.baseSpec())
  }

  private baseSpec(): BrowserSpec {
    return {
      browserType: this.config.browserType,
      channel: this.config.channel,
      executablePath: this.config.executablePath,
    }
  }

  private resolveSpec(override?: Partial<BrowserSpec>): BrowserSpec {
    const base = this.baseSpec()
    return {
      browserType: override?.browserType ?? base.browserType,
      channel: override?.channel ?? base.channel,
      executablePath: override?.executablePath ?? base.executablePath,
    }
  }

  private specKey(spec: BrowserSpec): string {
    return `${spec.browserType}|${resolveChannel(spec) ?? ''}|${spec.executablePath}`
  }

  private async doOpen(spec: BrowserSpec): Promise<Page> {
    let context: BrowserContext
    if (this.config.connectEndpoint !== '') {
      if (spec.browserType !== 'chromium') {
        throw new Error(
          `attach mode (connectEndpoint) is only supported for the chromium engine, not "${spec.browserType}". Clear connectEndpoint to launch ${labelFor(spec)} instead.`,
        )
      }
      const browser = await ENGINES.chromium.connectOverCDP(this.config.connectEndpoint)
      const existing = browser.contexts()[0]
      if (existing === undefined) {
        throw new Error(`connected to ${labelFor(spec)} over CDP but found no browser context`)
      }
      this.browser = browser
      context = existing
    } else {
      const userDataDir = this.config.userDataDir !== ''
        ? this.config.userDataDir
        : this.defaultUserDataDir(spec)
      const channel = resolveChannel(spec)
      context = await ENGINES[spec.browserType].launchPersistentContext(userDataDir, {
        ...(channel !== undefined ? { channel } : {}),
        headless: this.config.headless,
        ...(spec.executablePath !== '' ? { executablePath: spec.executablePath } : {}),
        viewport: this.config.viewport,
        timeout: this.config.timeoutMs,
      })
      this.browser = context.browser()
    }
    this.currentSpec = spec
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

  /** Default per-browser profile dir so distinct browsers never collide. */
  private defaultUserDataDir(spec: BrowserSpec): string {
    const name = spec.executablePath !== ''
      ? basename(spec.executablePath).replace(/[^a-zA-Z0-9._-]/gu, '_').toLowerCase()
      : (resolveChannel(spec) ?? spec.browserType)
    return join(homedir(), '.dsh', 'browser-profile', name)
  }

  /**
   * Return the active page, auto-launching when allowed. Throws a
   * model-recoverable message when the browser is closed.
   */
  async ensure(): Promise<Page> {
    if (this.context !== null) return this.requirePage()
    if (this.config.autoLaunch) return this.open()
    throw new Error(`${this.label} is not open. Run /browser or call the browser_open tool first.`)
  }

  /** Throw the standard model-recoverable error unless the browser is open. */
  assertOpen(): void {
    if (this.context === null) {
      throw new Error(`${this.label} is not open. Run /browser or call the browser_open tool first.`)
    }
  }

  /** The active page; throws when closed. */
  page(): Page {
    if (this.currentPage === null || this.currentPage.isClosed()) {
      throw new Error(`${this.label} is not open. Run /browser or call the browser_open tool first.`)
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
    this.currentSpec = null
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
    // Anything already carrying a scheme — https?://, scheme://, and
    // scheme-only forms like about:blank, data:, file: — passes through.
    // ('localhost:1420' only looks like a scheme; what follows is a port.)
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) return url
    if (/^(?:about|chrome|chrome-extension|chrome-untrusted|edge|moz-extension|data|blob|file|view-source):/iu.test(url)) return url
    return `${isLocalHost(url) ? 'http' : 'https'}://${url}`
  }

  private requirePage(): Page {
    const pages = this.pages()
    if (this.currentPage !== null && !this.currentPage.isClosed()) return this.currentPage
    if (pages.length > 0) {
      this.currentPage = pages[pages.length - 1]!
      return this.currentPage
    }
    throw new Error(`no pages are open in ${this.label}`)
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
