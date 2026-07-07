import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { api } from '../lib/api.js'
import { useToast } from '../composables/useToast.js'
import { CodeEditor } from '../components/CodeEditor.js'
import { Icon } from '../components/Icon.js'

export const meta = { layout: 'menu', title: 'SQL' }

function SqlPage() {
  useMeta({ title: 'SQL · Cogworks' })
  const toast = useToast()

  const s = reactive(
    /** @type {{ mode: 'readonly'|'sandbox', running: boolean, result: any, error: string, tables: string[], saved: any[]|null }} */
    ({ mode: 'readonly', running: false, result: null, error: '', tables: [], saved: null }),
  )
  let sql = "SELECT name, type FROM sqlite_schema WHERE type = 'table' ORDER BY name;"

  api.get('/api/v1/collections')
    .then((r) => { s.tables = (/** @type {any} */ (r)?.data ?? []).map((/** @type {any} */ c) => `cw_${c.name}`) })
    .catch(() => {})

  const loadSaved = () => api.get('/api/v1/admin/sql/queries').then((r) => { s.saved = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.saved = [] })
  loadSaved()

  async function saveCurrent() {
    const name = globalThis.prompt('Save query as:')
    if (!name?.trim()) return
    try {
      const r = /** @type {any} */ (await api.post('/api/v1/admin/sql/queries', { name: name.trim(), sql }))
      if (r?.error) throw new Error(r.error)
      toast.success('Query saved'); await loadSaved()
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Save failed') }
  }
  async function runSaved(/** @type {any} */ q) {
    if (s.running) return
    s.running = true; s.error = ''
    try {
      const r = /** @type {any} */ (await api.post(`/api/v1/admin/sql/queries/${q.id}/run`, { mode: s.mode }))
      if (r?.error) { s.error = r.error; s.result = null }
      else { s.result = r?.data ?? null; if (s.result && s.result.ok === false) s.error = s.result.error || 'Query failed' }
    } catch (/** @type {any} */ e) { s.error = e?.message || 'Request failed' } finally { s.running = false }
  }
  async function deleteSaved(/** @type {string} */ id, /** @type {string} */ name) {
    if (!globalThis.confirm(`Delete saved query "${name}"?`)) return
    try { const r = /** @type {any} */ (await api.delete(`/api/v1/admin/sql/queries/${id}`)); if (r?.error) throw new Error(r.error); toast.success('Deleted'); await loadSaved() } catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') }
  }

  async function run() {
    if (s.running) return
    s.running = true; s.error = ''
    try {
      const r = /** @type {any} */ (await api.post('/api/v1/admin/sql/run', { sql, mode: s.mode }))
      if (r?.error) { s.error = r.error; s.result = null }
      else { s.result = r?.data ?? null; if (s.result && s.result.ok === false) s.error = s.result.error || 'Query failed' }
    } catch (/** @type {any} */ e) { s.error = e?.message || 'Request failed' } finally { s.running = false }
  }

  const modeBtn = (/** @type {'readonly'|'sandbox'} */ m, /** @type {string} */ label) =>
    html`<button aria-pressed="${() => (s.mode === m ? 'true' : 'false')}" @click="${() => { s.mode = m }}" class="${() => `btn btn-sm ${s.mode === m ? 'btn-primary' : 'btn-secondary'}`}">${label}</button>`

  return html`
    <div class="space-y-4">
      <div class="flex items-end justify-between">
        <div>
          <h1 class="font-display text-2xl font-semibold text-fg">SQL editor</h1>
          <p class="mt-0.5 text-sm text-fg-soft">Query live data read-only, or write against a throwaway sandbox copy.</p>
        </div>
        <div class="flex items-center gap-1.5">${modeBtn('readonly', 'Read-only')}${modeBtn('sandbox', 'Sandbox')}</div>
      </div>

      <div class="grid gap-4 lg:grid-cols-[220px_1fr]">
        <div class="space-y-4">
          <div class="card overflow-hidden">
            <div class="card-head"><span class="card-title">Tables</span></div>
            <div class="p-2">
              <p class="px-2 pb-2 text-[11px] leading-snug text-fg-faint">Collections are stored as physical tables prefixed <span class="mono text-fg-soft">cw_</span>. Query <span class="mono text-fg-soft">cw_articles</span>, not <span class="mono">articles</span>. Click to copy.</p>
              <div class="max-h-[38vh] space-y-0.5 overflow-y-auto">
                ${() => (s.tables.length ? s.tables : ['(no collections)']).map((t) => html`
                  <button class="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-left mono text-xs text-fg-soft hover:bg-surface-hover hover:text-fg" @click="${() => { navigator.clipboard?.writeText(t); toast.success(`Copied ${t}`) }}">
                    ${Icon({ name: 'data', size: 13, class: 'text-fg-faint' })} <span class="truncate">${t}</span>
                  </button>`.key(t))}
              </div>
            </div>
          </div>

          <div class="card overflow-hidden">
            <div class="card-head"><span class="card-title">Saved queries</span></div>
            <div class="p-2">
              ${() => {
                if (s.saved === null) return html`<div class="p-3 text-center text-xs text-fg-faint">Loading…</div>`
                if (!s.saved.length) return html`<div class="px-2 py-3 text-xs text-fg-faint">None yet. Write a query and hit <span class="text-fg-soft">Save</span>.</div>`
                return html`<div class="max-h-[32vh] space-y-0.5 overflow-y-auto">${s.saved.map((q) => html`
                  <div class="group flex items-center gap-1 rounded-control px-2 py-1.5 hover:bg-surface-hover">
                    <button class="min-w-0 flex-1 truncate text-left text-xs text-fg-soft hover:text-fg" title="${q.description || q.name}" @click="${() => runSaved(q)}">${Icon({ name: 'play', size: 11, class: 'text-fg-faint' })} <span class="truncate">${q.name}</span></button>
                    <button class="text-fg-faint hover:text-fg" title="Delete" @click="${() => deleteSaved(q.id, q.name)}">${Icon({ name: 'trash', size: 12 })}</button>
                  </div>`.key(q.id))}</div>`
              }}
            </div>
          </div>
        </div>

        <div class="space-y-4">
          <div class="card overflow-hidden">
            ${CodeEditor({ value: sql, language: 'sql', height: 240, onChange: (v) => { sql = v }, tables: () => s.tables })}
            <div class="flex items-center gap-3 border-t border-line px-3 py-2.5">
              <button class="btn btn-primary btn-sm" aria-disabled="${() => (s.running ? 'true' : 'false')}" @click="${run}">${Icon({ name: 'play', size: 13, fill: true })} ${() => (s.running ? 'Running…' : 'Run')}</button>
              <button class="btn btn-secondary btn-sm" @click="${saveCurrent}">${Icon({ name: 'plus', size: 13 })} Save</button>
              ${() => (s.result && s.result.ok !== false ? html`<span class="mono text-xs text-fg-faint">${s.result.rowCount} rows · ${Math.round(s.result.durationMs)}ms${s.result.truncated ? ' · truncated' : ''}</span>` : '')}
            </div>
          </div>

          ${() => (s.error ? html`<div class="rounded-panel border px-4 py-3 mono text-xs" style="border-color:var(--color-bad);color:var(--color-bad);background:color-mix(in srgb, var(--color-bad) 8%, transparent)">${s.error}</div>` : '')}

          ${() =>
            s.result && s.result.ok !== false && s.result.columns?.length
              ? html`
                <div class="card overflow-auto" style="max-height:calc(100vh - 26rem)">
                  <div class="min-w-max">
                    <div class="flex thead">
                      ${s.result.columns.map((/** @type {string} */ col) => html`<div class="tcell tcell-mono min-w-36 flex-1 whitespace-nowrap py-2!">${col}</div>`.key(col))}
                    </div>
                    ${s.result.rows.map((/** @type {any[]} */ row, /** @type {number} */ i) =>
                      html`<div class="flex trow">
                        ${row.map((cell, /** @type {number} */ j) => html`<div class="tcell tcell-mono min-w-36 flex-1 whitespace-nowrap text-fg-soft">${cell === null ? html`<span class="text-fg-faint">null</span>` : String(cell)}</div>`.key(j))}
                      </div>`.key(i),
                    )}
                  </div>
                </div>`
              : ''}
        </div>
      </div>
    </div>
  `
}

export default SqlPage
