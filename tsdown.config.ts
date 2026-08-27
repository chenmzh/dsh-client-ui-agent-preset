import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { basename, dirname, resolve as resolvePath, sep } from 'node:path'
import { transform } from 'lightningcss'
import { defineConfig, type UserConfig } from 'tsdown'

const PACKAGE_ID = '@deepseek-ai/dsh-client-ui-agent-preset'
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

// These modules are supplied by the DSH browser module table. Keeping their
// specifiers external preserves the shared React/Cordis/UI runtime identities.
const CLIENT_MODULE_TABLE = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-connection',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-ui-conversation',
  '@deepseek-ai/dsh-client-ui-settings',
  '@deepseek-ai/dsh-api-remotes',
])

/** Resolve a stylesheet imported by JavaScript emitted under lib/types. */
function sourceStylesheet(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(
    emitted.slice(0, boundary),
    'src',
    emitted.slice(boundary + TYPES_MARKER.length),
  )
}

/** Emit one style tag and the CSS-module class map at bundle evaluation time. */
function styleInjectionModule(
  fileId: string,
  css: string,
  classMap: Readonly<Record<string, string>>,
): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${PACKAGE_ID}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(PACKAGE_ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

/** Inline CSS modules while retaining their generated class map. */
const cssModulesPlugin = {
  name: 'dsh-client-ui-agent-preset-css-modules',
  resolveId(source: string, importer: string | undefined) {
    if (!source.endsWith('.module.css')) return null
    const file = importer === undefined ? source : sourceStylesheet(source, importer)
    return CSS_VIRTUAL_PREFIX + file + CSS_VIRTUAL_SUFFIX
  },
  async load(this: { addWatchFile: (filePath: string) => void }, virtualId: string) {
    if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    this.addWatchFile(fileId)
    const source = await readFile(fileId)
    const result = transform({
      filename: fileId,
      code: source,
      cssModules: { pattern: '[hash]_[local]' },
      minify: true,
    })
    const classMap: Record<string, string> = {}
    for (const [local, exported] of Object.entries(result.exports ?? {})) {
      classMap[local] = exported.name
    }
    return styleInjectionModule(fileId, result.code.toString(), classMap)
  },
}

const nodeLibrary: UserConfig = {
  entry: {
    index: 'lib/types/index.js',
    invariant: 'lib/types/invariant.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
}

const browserBundle: UserConfig = {
  entry: { client: 'lib/types/client/index.js' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => CLIENT_MODULE_TABLE.has(specifier),
    alwaysBundle: (specifier: string) =>
      !isBuiltin(specifier) && !CLIENT_MODULE_TABLE.has(specifier),
  },
  plugins: [cssModulesPlugin],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([nodeLibrary, browserBundle])
