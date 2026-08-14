# PENDING FIXES — dsh-browser

Work item per la prossima sessione. I fix qui sotto sono **tutti da applicare**
sul working tree (che è **uncommitted**). Dopo averli applicati, esegui la
verifica finale in fondo e committa.

## Contesto (per riprendere il filo)

- Il repo è stato rinominato `deepseek-chrome` → `dsh-browser` (percorso:
  `/Users/mgallo/repo/dsh-browser`).
- Refactor browser-agnostic già fatto: `browserType` (`chromium`/`firefox`/`webkit`),
  `channel`, `executablePath`, fallback su **Chrome**, comando
  `/browser [browser] [url]` con alias `chrome`, `chromium`, `edge`/`msedge`,
  `firefox`, `webkit`.
- **NOTA sessione**: il workspace dell'agente è rimasto
  `/Users/mgallo/repo/deepseek-chrome` (path ora inesistente). Nella prossima
  sessione usare path assoluti su `/Users/mgallo/repo/dsh-browser`.

## Bug 1 — `specKey` confronta il channel grezzo (riapertura inutile del browser)

File: `src/browser.ts`, metodo `specKey`.

Il default (`/browser`) apre Chrome con `channel: ''` (che poi risolve a
`chrome`), mentre l'alias `/browser chrome` usa `channel: 'chrome'`. Le chiavi
`"chromium||"` e `"chromium|chrome|"` risultano diverse → chiude e riapre
Chrome (stesso browser), perdendo tab/stato. Vale anche nel verso opposto.

**Fix** — normalizzare il channel con `resolveChannel`:

```ts
private specKey(spec: BrowserSpec): string {
  return `${spec.browserType}|${resolveChannel(spec) ?? ''}|${spec.executablePath}`
}
```

## Bug 2 — `browser_close` riporta il browser sbagliato

File: `src/tools.ts`, tool `browser_close`.

`close()` azzera `currentSpec`, quindi `${browser.label}` dopo la chiusura
ricade sul default ("Chrome") anche se avevi chiuso Edge.

**Fix** — catturare il label prima di chiudere:

```ts
async execute(_args, exec) {
  exec.signal.throwIfAborted()
  const label = browser.label
  await browser.close()
  return `${label} closed.`
}
```

## Minor 3+4 — `browserAliases()` inutilizzata + description hardcoded

File: `src/index.ts`.

`browserAliases()` è esportata ma mai usata; la description del comando duplica
la lista degli alias (e omette `msedge`).

**Fix** — importarla e usarla nella description:

```ts
import { BrowserService, browserAliases, resolveBrowserAlias, type BrowserSpec } from './browser.ts'
```

```ts
description: `Open a browser and browse the web: /browser [browser] [url] (browser: ${browserAliases().join(', ')})`,
```

## Minor 5 — `.env.example` placeholder incoerente

File: `.env.example`.

`DSH_BROWSER_CHECKOUT=/path/to/deepseek-chrome` → `DSH_BROWSER_CHECKOUT=/path/to/dsh-browser`
(per coerenza con `dev.patch.yml.example`, che già usa `/path/to/dsh-browser`).

## Verifica finale (dopo i fix)

```sh
cd /Users/mgallo/repo/dsh-browser
pnpm typecheck
pnpm build
# smoke test: deve stampare "15 ["browser"]"
node --input-type=module -e "import('./lib/index.js').then(async m => { const tools=[],commands=[]; const ctx={tools:{register:d=>tools.push(d.name)},commands:{register:d=>commands.push(d.name)},effect:()=>()=>{},get:()=>undefined,logger:{warn(){},info(){}}}; m.apply(ctx,m.Config({})); console.log(tools.length, JSON.stringify(commands)); })"
git status
git add -A && git commit -m "Rename dsh-chrome -> dsh-browser; browser-agnostic + /browser [browser] [url]"
```

## Note opzionali (non bloccanti)

- `/browser firefox` / `webkit` / `chromium` richiedono i browser bundled
  Playwright (`npx playwright@1.61.1 install firefox webkit`) o un
  `executablePath` di sistema; su questa macchina non sono installati, quindi
  quegli alias danno `Executable doesn't exist`.
