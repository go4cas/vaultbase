import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { api, parseFields } from '../lib/api.js'
import { Link } from '../components/Link.js'

export const meta = { layout: 'menu', title: 'Files' }

function FilesPage() {
  useMeta({ title: 'Files · Cogworks' })

  const s = reactive(
    /** @type {{ storage: any, fileCols: any[]|null }} */
    ({ storage: null, fileCols: null }),
  )

  api.get('/api/v1/admin/settings/storage/status').then((r) => { s.storage = /** @type {any} */ (r)?.data ?? {} }).catch(() => { s.storage = {} })
  api.get('/api/v1/collections').then((r) => {
    const cols = /** @type {any} */ (r)?.data ?? []
    s.fileCols = cols
      .map((/** @type {any} */ c) => ({ ...c, fileFields: parseFields(c.fields).filter((/** @type {any} */ f) => f.type === 'file') }))
      .filter((/** @type {any} */ c) => c.fileFields.length)
  }).catch(() => { s.fileCols = [] })

  return html`
    <div class="space-y-8">
      <div>
        <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">files</div>
        <h1 class="mt-1 font-display text-2xl font-semibold text-fg">Files</h1>
        <p class="mt-1 text-sm text-fg-soft">Where uploads live and how they're served.</p>
      </div>

      <section class="rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
        <div class="mb-4 font-mono text-[11px] uppercase tracking-wider text-fg-faint">Storage driver</div>
        <div class="grid gap-4 sm:grid-cols-[0.5fr_1.5fr]">
          <div>
            <div class="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Driver</div>
            <div class="mt-1 inline-flex items-center gap-2 font-display text-xl font-semibold text-fg">
              <span class="h-2 w-2 rounded-full" style="background:var(--color-ok)"></span>
              ${() => (s.storage === null ? '…' : (s.storage.driver ?? 'local'))}
            </div>
          </div>
          <div>
            <div class="font-mono text-[10px] uppercase tracking-wider text-fg-faint">Location</div>
            <div class="mt-1 truncate font-mono text-xs text-fg-soft">${() => (s.storage === null ? '…' : (s.storage.uploadDir || s.storage.bucket || '—'))}</div>
          </div>
        </div>
      </section>

      <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
        <div class="border-b border-line px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-fg-faint">File fields</div>
        ${() => {
          if (s.fileCols === null) return html`<div class="px-4 py-6 text-center text-fg-faint">Loading…</div>`
          if (!s.fileCols.length) return html`<div class="px-4 py-6 text-center text-fg-faint">No file fields yet — add a <span class="font-mono">file</span> field to a collection in Data.</div>`
          return html`<div>${s.fileCols.map((c) => html`
            <div class="flex items-center justify-between border-b border-line/60 px-4 py-3">
              <div>
                <span class="font-medium text-fg">${c.name}</span>
                <span class="ml-2 font-mono text-[11px] text-fg-faint">${c.fileFields.map((/** @type {any} */ f) => f.name).join(', ')}</span>
              </div>
              ${Link({ to: `/collections/${c.id}`, children: 'schema →', class: 'font-mono text-[11px] text-fg-faint hover:text-brand' })}
            </div>`.key(c.id))}</div>`
        }}
      </section>
    </div>
  `
}

export default FilesPage
