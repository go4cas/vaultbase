// monaco-editor's package `exports` maps subpaths via "./*":"./*" without type
// resolution, so tsc can't find types for the ESM entry points Vite bundles.
// Re-point them at the umbrella types (value import stays the trimmed ESM path).
declare module 'monaco-editor/esm/vs/editor/editor.api' {
  export * from 'monaco-editor'
}
declare module 'monaco-editor/esm/vs/basic-languages/sql/sql.contribution'
