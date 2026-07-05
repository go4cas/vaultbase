import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { api } from '../lib/api.js'

export const meta = { layout: 'menu', title: 'Settings' }

/** Group flat "a.b.c" setting keys by their first segment. */
function groupSettings(/** @type {Record<string, any>} */ flat) {
  /** @type {Record<string, Array<{ key: string, value: any }>>} */
  const groups = {}
  for (const [k, v] of Object.entries(flat ?? {})) {
    const g = k.includes('.') ? k.slice(0, k.indexOf('.')) : 'general'
    ;(groups[g] ??= []).push({ key: k, value: v })
  }
  return groups
}

const render = (/** @type {any} */ v) => {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function SettingsPage() {
  useMeta({ title: 'Settings · Cogworks' })

  const s = reactive(
    /** @type {{ settings: any, storage: any }} */
    ({ settings: null, storage: null }),
  )

  api.get('/api/v1/admin/settings').then((r) => { s.settings = /** @type {any} */ (r)?.data ?? {} }).catch(() => { s.settings = {} })
  api.get('/api/v1/admin/settings/storage/status').then((r) => { s.storage = /** @type {any} */ (r)?.data ?? {} }).catch(() => { s.storage = {} })

  return html`
    <div class="space-y-8">
      <div>
        <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">operate</div>
        <h1 class="mt-1 font-display text-2xl font-semibold text-fg">Settings</h1>
        <p class="mt-1 text-sm text-fg-soft">Configuration and the levers that keep the machine running.</p>
      </div>

      <div class="grid gap-4 sm:grid-cols-3">
        <div class="rounded-panel border border-line bg-surface-raised p-4 shadow-panel">
          <div class="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Latest release</div>
          <div class="mt-1 font-display text-xl font-semibold text-brand">${() => (s.settings?.['update_check.latest_version'] || 'v0.1.0')}</div>
        </div>
        <div class="rounded-panel border border-line bg-surface-raised p-4 shadow-panel">
          <div class="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Storage</div>
          <div class="mt-1 font-display text-xl font-semibold text-fg">${() => (s.storage === null ? '…' : (s.storage.driver ?? 'local'))}</div>
        </div>
        <div class="rounded-panel border border-line bg-surface-raised p-4 shadow-panel">
          <div class="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Settings keys</div>
          <div class="mt-1 font-display text-xl font-semibold text-fg">${() => (s.settings === null ? '…' : Object.keys(s.settings).length)}</div>
        </div>
      </div>

      ${() => {
        if (s.settings === null) return html`<div class="rounded-panel border border-line bg-surface-raised px-4 py-6 text-center text-sm text-fg-faint shadow-panel">Loading settings…</div>`
        const groups = groupSettings(s.settings)
        const names = Object.keys(groups).sort()
        if (!names.length) return html`<div class="rounded-panel border border-line bg-surface-raised px-4 py-6 text-center text-sm text-fg-faint shadow-panel">No settings configured — defaults in effect.</div>`
        return html`<div class="space-y-6">${names.map((g) => html`
          <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
            <div class="border-b border-line px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-fg-faint">${g}</div>
            <div>${groups[g].map((row) => html`
              <div class="grid grid-cols-[1.4fr_1fr] items-center border-b border-line/60">
                <div class="px-4 py-2.5 font-mono text-xs text-fg-soft">${row.key}</div>
                <div class="truncate px-4 py-2.5 font-mono text-xs text-fg">${render(row.value)}</div>
              </div>`.key(row.key))}</div>
          </section>`.key(g))}</div>`
      }}
    </div>
  `
}

export default SettingsPage
