/**
 * dsh-ide-layout build: node half (lib/index.js, host fs service + routes)
 * plus the browser half (lib/client.js, closure-factory artifact consumed by
 * the web GUI's __ModuleLoader__). Modeled on the dsh-web-ui shared preset
 * (Apache-2.0) but self-contained: no repo-relative imports.
 */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
] as const

/** Externals answered by the loader module table (+ the runtime exemption). */
const CLIENT_EXTERNALS = [...PLATFORM_MODULES, '@deepseek-ai/dsh-client-runtime/client']

/** Node-half externals (resolved from the dsh profile tree at runtime).
 *  LSP 语言服务器（typescript-language-server + typescript）不能被 tsdown 打进
 *  bundle——host 半区用 createRequire 解析其真实路径后 spawn 独立进程，
 *  必须保持 node_modules 中的原始布局。 */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-subprocess',
  '@deepseek-ai/dsh-workspace',
  '@deepseek-ai/dsh-system-prompt',
  'typescript-language-server',
  'typescript',
]

export default [
  // --- node half ---
  {
    name: 'dsh-ide-layout',
    entry: ['src/index.ts'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: HOST_EXTERNALS,
  },
  // --- browser half ---
  {
    name: 'dsh-ide-layout/client',
    entry: { client: 'src/client/index.ts' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    // Everything outside the loader module table inlines into the bundle.
    noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-ide-layout", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
]
