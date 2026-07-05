import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { api } from '../lib/api.js'
import { CodeEditor } from '../components/CodeEditor.js'

export const meta = { layout: 'menu', title: 'SQL runner' }

function SqlPage() {
  useMeta({ title: 'SQL runner · Cogworks' })

  const s = reactive(
    /** @type {{ mode: 'readonly'|'sandbox', running: boolean, result: any, error: string, tables: string[] }} */
    ({ mode: 'readonly', running: false, result: null, error: '', tables: [] }),
  )
  let sql = 'SELECT name, type FROM sqlite_schema WHERE type = \'table\' ORDER BY name;'

  // Live table names feed Monaco completion (proves the IntelliSense wiring).
  api.get('/api/v1/collections')
    .then((r) => { s.tables = (/** @type {any} */ (r)?.data ?? []).map((/** @type {any} */ c) => `cw_${c.name}`) })
    .catch(() => {})

  async function run() {
    if (s.running) return
    s.running = true
    s.error = ''
    try {
      const r = /** @type {any} */ (await api.post('/api/v1/admin/sql/run', { sql, mode: s.mode }))
      if (r?.error) { s.error = r.error; s.result = null }
      else { s.result = r?.data ?? null; if (s.result && s.result.ok === false) s.error = s.result.error || 'Query failed' }
    } catch (/** @type {any} */ e) {
      s.error = e?.message || 'Request failed'
    } finally {
      s.running = false
    }
  }

  const modeBtn = (/** @type {'readonly'|'sandbox'} */ m, /** @type {string} */ label) =>
    html`<button
      @click="${() => { s.mode = m }}"
      class="${() => `rounded-control px-3 py-1.5 font-mono text-xs transition ${s.mode === m ? 'bg-brand text-[#12233f]' : 'border border-line text-fg-soft hover:bg-surface-inset'}`}"
    >${label}</button>`

  return html`
    <div class="space-y-5">
      <div class="flex items-end justify-between">
        <div>
          <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">operate</div>
          <h1 class="mt-1 font-display text-2xl font-semibold text-fg">SQL runner</h1>
          <p class="mt-1 text-sm text-fg-soft">Read-only against live data, or a throwaway sandbox copy.</p>
        </div>
        <div class="flex items-center gap-2">
          ${modeBtn('readonly', 'read-only')}
          ${modeBtn('sandbox', 'sandbox')}
        </div>
      </div>

      ${CodeEditor({ value: sql, language: 'sql', height: 220, onChange: (v) => { sql = v }, tables: () => s.tables })}

      <div class="flex items-center gap-3">
        <button
          @click="${run}"
          aria-disabled="${() => (s.running ? 'true' : 'false')}"
          class="${() => `rounded-control bg-brand px-4 py-2 text-sm font-semibold text-[#12233f] shadow-panel transition ${s.running ? 'cursor-not-allowed opacity-50' : 'hover:bg-brand-hover'}`}"
        >${() => (s.running ? 'Running…' : 'Run ▸')}</button>
        ${() => (s.result && s.result.ok !== false ? html`<span class="font-mono text-[11px] text-fg-faint">${s.result.rowCount} rows · ${Math.round(s.result.durationMs)}ms${s.result.truncated ? ' · truncated' : ''}</span>` : '')}
      </div>

      ${() => (s.error ? html`<div class="rounded-control border border-line bg-surface-inset px-4 py-3 font-mono text-xs" style="color:var(--color-bad)">${s.error}</div>` : '')}

      ${() =>
        s.result && s.result.ok !== false && s.result.columns?.length
          ? html`
            <div class="overflow-auto rounded-panel border border-line bg-surface-raised shadow-panel">
              <div class="min-w-max font-mono text-xs">
                <div class="flex border-b border-line text-fg-faint">
                  ${s.result.columns.map((/** @type {string} */ col) => html`<div class="min-w-36 flex-1 whitespace-nowrap px-3 py-2 font-medium">${col}</div>`)}
                </div>
                ${s.result.rows.map((/** @type {any[]} */ row, /** @type {number} */ i) =>
                  html`<div class="flex border-b border-line/50">
                    ${row.map((cell) => html`<div class="min-w-36 flex-1 whitespace-nowrap px-3 py-1.5 text-fg-soft">${cell === null ? html`<span class="text-fg-faint">null</span>` : String(cell)}</div>`)}
                  </div>`.key(i),
                )}
              </div>
            </div>`
          : ''}
    </div>
  `
}

export default SqlPage
