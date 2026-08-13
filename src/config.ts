/**
 * Plugin configuration, validated by Schemastery before `apply` runs.
 * @module dsh-chrome/config
 */

import Schema from '@deepseek-ai/schemastery'

/** Browser viewport for freshly created contexts. */
export interface Viewport {
  width: number
  height: number
}

export interface Config {
  /** Playwright browser channel (e.g. `chrome`, `msedge`, `chromium`). */
  channel: string
  /** Run without a visible window. */
  headless: boolean
  /** Absolute path to a browser executable; empty selects the channel default. */
  executablePath: string
  /** Persistent profile directory; empty uses `~/.dsh/chrome-profile`. */
  userDataDir: string
  /** CDP endpoint (e.g. `http://127.0.0.1:9222`); empty means launch instead of connect. */
  connectEndpoint: string
  /** Browser tools auto-launch Chrome when none is open. */
  autoLaunch: boolean
  viewport: Viewport
  /** Default per-action timeout in milliseconds. */
  timeoutMs: number
}

export const Config: Schema<Config> = Schema.object({
  channel: Schema.string().default('chrome'),
  headless: Schema.boolean().default(false),
  executablePath: Schema.string().default(''),
  userDataDir: Schema.string().default(''),
  connectEndpoint: Schema.string().default(''),
  autoLaunch: Schema.boolean().default(true),
  viewport: Schema.object({
    width: Schema.number().default(1280),
    height: Schema.number().default(800),
  }),
  timeoutMs: Schema.number().default(15000),
})
