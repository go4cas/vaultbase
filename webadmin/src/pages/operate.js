import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useToast } from '../composables/useToast.js'
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
  const toast = useToast()

  const s = reactive(
    /** @type {{ settings: any, storage: any, busy: boolean }} */
    ({ settings: null, storage: null, busy: false }),
  )
  let setKey = ''
  let setVal = ''

  const load = () => api.get('/api/v1/admin/settings').then((r) => { s.settings = /** @type {any} */ (r)?.data ?? {} }).catch(() => { s.settings = {} })
  load()
  api.get('/api/v1/admin/settings/storage/status').then((r) => { s.storage = /** @type {any} */ (r)?.data ?? {} }).catch(() => { s.storage = {} })

  async function applySetting() {
    if (s.busy) return
    if (!setKey.trim()) { toast.error('Key is required'); return }
    s.busy = true
    try {
      const r = /** @type {any} */ (await api.patch('/api/v1/admin/settings', { [setKey.trim()]: setVal }))
      if (r?.error) throw new Error(r.error)
      toast.success('Setting saved')
      await load()
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Save failed')
    } finally {
      s.busy = false
    }
  }
  const inputCls = 'rounded-control border border-line bg-surface-inset px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-brand'

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

      <div class="rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
        <div class="mb-3 font-mono text-[11px] uppercase tracking-wider text-fg-faint">Set a value</div>
        <div class="flex flex-wrap items-center gap-2">
          <input class="${`${inputCls} flex-1`}" placeholder="setting.key" @input="${(/** @type {any} */ e) => { setKey = e.target.value }}" />
          <input class="${`${inputCls} flex-1`}" placeholder="value" @input="${(/** @type {any} */ e) => { setVal = e.target.value }}" />
          <button @click="${applySetting}" aria-disabled="${() => (s.busy ? 'true' : 'false')}" class="${() => `rounded-control px-4 py-2 text-sm font-semibold text-[#12233f] transition ${s.busy ? 'bg-brand/40' : 'bg-brand hover:bg-brand-hover'}`}">${() => (s.busy ? 'saving…' : 'Set')}</button>
        </div>
        <p class="mt-2 font-mono text-[10px] text-fg-faint">Owner escape hatch — writes any key via PATCH /admin/settings. Curated per-concern panels are the next build.</p>
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
