import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useRouter } from '../composables/useRouter.js'
import { api, parseFields } from '../lib/api.js'
import { Icon } from '../components/Icon.js'

export const meta = { layout: 'menu', title: 'Storage' }

function StoragePage() {
  useMeta({ title: 'Storage · Cogworks' })
  const router = useRouter()

  const s = reactive(/** @type {{ storage: any, fileCols: any[]|null }} */ ({ storage: null, fileCols: null }))
  api.get('/api/v1/admin/settings/storage/status').then((r) => { s.storage = /** @type {any} */ (r)?.data ?? {} }).catch(() => { s.storage = {} })
  api.get('/api/v1/collections').then((r) => {
    const cols = /** @type {any} */ (r)?.data ?? []
    s.fileCols = cols.map((/** @type {any} */ c) => ({ ...c, fileFields: parseFields(c.fields).filter((/** @type {any} */ f) => f.type === 'file') })).filter((/** @type {any} */ c) => c.fileFields.length)
  }).catch(() => { s.fileCols = [] })

  return html`
    <div class="space-y-5">
      <div>
        <h1 class="font-display text-2xl font-semibold text-fg">Storage</h1>
        <p class="mt-0.5 text-sm text-fg-soft">Where uploads live and how they're served.</p>
      </div>

      <div class="card card-pad">
        <div class="mb-4 card-title">Storage driver</div>
        <div class="grid gap-4 sm:grid-cols-[0.5fr_1.5fr]">
          <div>
            <div class="field-label">Driver</div>
            <div class="mt-1 inline-flex items-center gap-2 font-display text-xl font-semibold text-fg">
              <span class="dot" style="background:var(--color-ok)"></span>${() => (s.storage === null ? '…' : (s.storage.driver ?? 'local'))}
            </div>
          </div>
          <div>
            <div class="field-label">Location</div>
            <div class="mt-1.5 truncate mono text-xs text-fg-soft">${() => (s.storage === null ? '…' : (s.storage.uploadDir || s.storage.bucket || '—'))}</div>
          </div>
        </div>
      </div>

      <div class="card overflow-hidden">
        <div class="card-head"><span class="card-title">File fields</span></div>
        ${() => {
          if (s.fileCols === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
          if (!s.fileCols.length) return html`<div class="p-8 text-center text-sm text-fg-faint">No file fields yet — add a <span class="mono">file</span> field to a collection in Data.</div>`
          return html`<div>${s.fileCols.map((c) => html`
            <div class="trow flex items-center justify-between px-4 py-3">
              <div class="flex items-center gap-2">
                <span class="text-fg-faint">${Icon({ name: 'storage', size: 15 })}</span>
                <span class="font-medium text-fg">${c.name}</span>
                <span class="mono text-xs text-fg-faint">${c.fileFields.map((/** @type {any} */ f) => f.name).join(', ')}</span>
              </div>
              <button class="btn btn-ghost btn-sm" @click="${() => router.go(`/collections/${c.id}`)}">Open ${Icon({ name: 'chevronRight', size: 13 })}</button>
            </div>`.key(c.id))}</div>`
        }}
      </div>
    </div>
  `
}

export default StoragePage
