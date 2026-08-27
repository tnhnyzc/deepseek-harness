/**
 * SPEC §31 architectural boundary tests: source scans whose sole purpose is
 * preventing future architectural decay. Electron main must never import DSH
 * product packages (agent loop, session internals, model providers, tool
 * implementations); the renderer may import only the browser client surface
 * (the pinned DSH client packages' browser entries, stage 4) and must never
 * import electron, Node built-ins, or DSH host runtime packages; the desktop
 * transport must never name a business RPC or stream; and desktop production
 * code must never create a localhost HTTP listener.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const DESKTOP_ROOT = resolve(import.meta.dirname, '..')
const RUNTIME_ROOT = resolve(DESKTOP_ROOT, '..', 'desktop-runtime')

/**
 * The closed wire protocols desktop source may import: the fetch/stream
 * transport and the native capability protocol. Both are OS/transport
 * vocabulary only; every other DSH package stays forbidden.
 */
const PROTOCOL_SPECIFIERS: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-desktop-runtime/transport',
  '@deepseek-ai/dsh-desktop-runtime/native',
])

function listSources(root: string, extensions: ReadonlySet<string>): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry)
      const stats = statSync(path)
      if (stats.isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'lib') continue
        walk(path)
      } else if (extensions.has(entry.split('.').pop() ?? '')) {
        out.push(path)
      }
    }
  }
  walk(root)
  return out
}

/** Every module specifier a source file imports (static, side-effect, dynamic, require). */
function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\s+['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1] !== undefined) specifiers.push(match[1])
    }
  }
  return specifiers
}

const DSH_PRODUCT_PACKAGE = /^@deepseek-ai\/dsh-(?!desktop-runtime\/transport$)/
const ELECTRON_SPECIFIER = /^electron(\/|$)/
const NODE_BUILTIN = /^node:/

/**
 * The browser client surface stage 4 admits in the renderer: the pinned DSH
 * client packages, only their browser entries (the client tree runs there
 * unchanged). Everything else — host runtime, agents, providers — stays
 * forbidden.
 */
const RENDERER_ALLOWED_DSH: ReadonlySet<string> = new Set([
  '@deepseek-ai/dsh-client-web',
  '@deepseek-ai/dsh-client-connection/client',
  // The event-path constants: imported through the package's declared
  // `./src/*` subpath because the built `/client` entry is the CJS module
  // factory, whose named exports the renderer bundler cannot read.
  '@deepseek-ai/dsh-client-connection/src/api-path.ts',
  '@deepseek-ai/dsh-host-apiproxy/client',
])

/**
 * Business RPC and stream-semantics literals. The transport is generic: a
 * name from the product vocabulary here is architectural decay by definition.
 */
const BUSINESS_LITERALS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /session\.[a-z][a-z]*/gi, reason: 'business RPC name' },
  { pattern: /events\.(mux|host)/gi, reason: 'business stream identifier' },
  { pattern: /\bapproval[a-z./_-]*/gi, reason: 'business stream/RPC name' },
  { pattern: /\bquestion[a-z./_-]*/gi, reason: 'business stream/RPC name' },
  { pattern: /model\.[a-z][a-z]*/gi, reason: 'business RPC name' },
  { pattern: /tool\.[a-z][a-z]*/gi, reason: 'business RPC name' },
]

/** The desktop transport source files: every layer between the renderer port and the carrier. */
const TRANSPORT_FILES = [
  join(DESKTOP_ROOT, 'src', 'main', 'transport-broker.ts'),
  join(DESKTOP_ROOT, 'src', 'renderer', 'transport.ts'),
  join(DESKTOP_ROOT, 'src', 'preload', 'index.cjs'),
  join(RUNTIME_ROOT, 'src', 'transport.ts'),
  join(RUNTIME_ROOT, 'src', 'transport-runtime.ts'),
  join(RUNTIME_ROOT, 'src', 'transport-process.ts'),
]

/**
 * The desktop native capability source files: the OS capability surface on
 * both sides of the channel. Like the transport, they must name OS
 * capability vocabulary only, never a DSH business RPC.
 */
const NATIVE_FILES = [
  join(DESKTOP_ROOT, 'src', 'main', 'native-capabilities.ts'),
  join(DESKTOP_ROOT, 'src', 'main', 'native-channel.ts'),
  join(RUNTIME_ROOT, 'src', 'native.ts'),
  join(RUNTIME_ROOT, 'src', 'native-bridge.ts'),
]

/** The native protocol message tags: renderer-side knowledge of them is a bridge by definition. */
const NATIVE_PROTOCOL_TAGS = ['native.request', 'native.response', 'native.cancel', 'native.abort', 'directory.pick', 'path.open']

const HTTP_LISTENER = /createServer\s*\(|new\s+(?:net|http|https)\.Server|\.listen\(/

describe('SPEC §31 architectural boundaries', () => {
  it('keeps Electron main free of DSH product packages', () => {
    const mainFiles = listSources(join(DESKTOP_ROOT, 'src', 'main'), new Set(['ts']))
    expect(mainFiles.length).toBeGreaterThan(0)
    for (const file of mainFiles) {
      const source = readFileSync(file, 'utf8')
      const offenders = importSpecifiers(source).filter(specifier => !PROTOCOL_SPECIFIERS.has(specifier)
        && DSH_PRODUCT_PACKAGE.test(specifier))
      expect(offenders, `${file} imports DSH product packages`).toEqual([])
    }
  })

  it('keeps the renderer free of electron, Node built-ins, and DSH host runtime packages', () => {
    const rendererFiles = listSources(join(DESKTOP_ROOT, 'src', 'renderer'), new Set(['ts']))
    expect(rendererFiles.length).toBeGreaterThan(0)
    for (const file of rendererFiles) {
      const source = readFileSync(file, 'utf8')
      const offenders = importSpecifiers(source).filter((specifier) => {
        if (PROTOCOL_SPECIFIERS.has(specifier)) return false
        if (RENDERER_ALLOWED_DSH.has(specifier)) return false
        return ELECTRON_SPECIFIER.test(specifier) || NODE_BUILTIN.test(specifier) || DSH_PRODUCT_PACKAGE.test(specifier)
      })
      expect(offenders, `${file} imports renderer-forbidden modules`).toEqual([])
    }
  })

  it('keeps the desktop transport free of business RPC and stream literals', () => {
    expect(TRANSPORT_FILES).toHaveLength(6)
    for (const file of TRANSPORT_FILES) {
      const source = readFileSync(file, 'utf8')
      for (const { pattern, reason } of BUSINESS_LITERALS) {
        pattern.lastIndex = 0
        const match = source.match(pattern)
        expect(match, `${file} names a ${reason}`).toBeNull()
      }
    }
  })

  it('keeps the desktop native capability layers free of business RPC literals', () => {
    expect(NATIVE_FILES).toHaveLength(4)
    for (const file of NATIVE_FILES) {
      const source = readFileSync(file, 'utf8')
      for (const { pattern, reason } of BUSINESS_LITERALS) {
        pattern.lastIndex = 0
        const match = source.match(pattern)
        expect(match, `${file} names a ${reason}`).toBeNull()
      }
    }
  })

  it('gives the renderer and preload no native protocol knowledge', () => {
    const files = [
      ...listSources(join(DESKTOP_ROOT, 'src', 'renderer'), new Set(['ts'])),
      ...listSources(join(DESKTOP_ROOT, 'src', 'preload'), new Set(['cjs'])),
    ]
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      for (const tag of NATIVE_PROTOCOL_TAGS) {
        expect(source, `${file} names the native protocol tag ${tag}`).not.toContain(tag)
      }
    }
  })

  it('mounts exactly one directory-picker provider in the desktop composition', () => {
    const composition = readFileSync(join(RUNTIME_ROOT, 'src', 'composition.ts'), 'utf8')
    // The temporary host-native chooser package must not be mounted.
    expect(composition).not.toContain('dsh-host-directory-picker-native')
    // The overlay disables the web `auto` row and inserts the desktop provider.
    expect(composition).toContain('id: DESKTOP_PICKER_ROW_ID, disabled: true')
    expect(composition).toContain('DESKTOP_PICKER_MODULE_NAME')
  })

  it('creates no network listener in desktop production code', () => {
    const files = [
      ...listSources(join(DESKTOP_ROOT, 'src'), new Set(['ts', 'cjs'])),
      ...listSources(join(RUNTIME_ROOT, 'src'), new Set(['ts'])),
    ]
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      expect(source.match(HTTP_LISTENER), `${file} creates a network listener`).toBeNull()
    }
  })
})
