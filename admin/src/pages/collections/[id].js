import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../../framework/index.js'
import { useRoute } from '../../composables/useRoute.js'
import { useRouter } from '../../composables/useRouter.js'
import { useToast } from '../../composables/useToast.js'
import { api, apiDownload, apiPostText, parseFields } from '../../lib/api.js'
import { Icon } from '../../components/Icon.js'
import { Dialog } from '../../components/Dialog.js'
import { TabList } from '../../components/Tabs.js'
import { FIELD_TYPES, TYPE_OPTS, LIST_OPTS, fieldOut, fieldOptionControls } from '../../lib/fieldEditor.js'

export const meta = { layout: 'menu', title: 'Collection' }

/** @type {Record<string, string>} */
const KIND_COLOR = { base: 'var(--color-brand)', auth: 'var(--color-ok)', view: 'var(--color-warn)' }
const RULES = /** @type {const} */ ([
  ['list_rule', 'List'], ['view_rule', 'View'], ['create_rule', 'Create'], ['update_rule', 'Update'], ['delete_rule', 'Delete'],
])
const PER_PAGE = 20

const cell = (/** @type {any} */ v, /** @type {string} */ type) => {
  if (v === null || v === undefined || v === '') return html`<span class="text-fg-faint">—</span>`
  if (type === 'bool') return v ? html`<span style="color:var(--color-ok)">✓</span>` : html`<span class="text-fg-faint">✗</span>`
  if (type === 'date' || type === 'autodate') {
    const d = new Date(typeof v === 'number' ? v * 1000 : v)
    return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 16).replace('T', ' ')
  }
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function CollectionDetail() {
  const route = useRoute()
  const router = useRouter()
  const id = route.params().id
  const toast = useToast()

  const s = reactive(
    /** @type {{ col:any, error:string, tab:string, records:any[]|null, editing:string|null, saving:boolean,
     *   page:number, totalPages:number, totalItems:number, search:string, fieldRows:{id:number}[], fieldsRev:number,
     *   historyFor:string|null, history:any[]|null, vec:boolean, vecInfo:string,
     *   indexes:any[]|null, idxUnique:boolean, idxBusy:boolean, importing:boolean, otherCols:string[] }} */
    ({ col: null, error: '', tab: 'records', records: null, editing: null, saving: false, page: 1, totalPages: 1, totalItems: 0, search: '', fieldRows: [], fieldsRev: 0, historyFor: null, history: null, vec: false, vecInfo: '', indexes: null, idxUnique: false, idxBusy: false, importing: false, otherCols: [] }),
  )
  // Plain buffers so keystrokes don't re-render forms.
  /** @type {Record<string,any>} */ let formInit = {}
  /** @type {Record<string,any>} */ let formVals = {}
  /** @type {Record<string,string>} */ let ruleVals = {}
  /** @type {Record<number,any>} */ let fieldDraft = {}
  let rowSeq = 0
  let searchTerm = ''
  let renameVal = ''
  let vecInput = ''
  let vecField = ''
  let vecLimit = '10'
  let idxField = ''
  // Draft buffer is flat for the form; options nest back into `options` on save.

  const RULE_KEYS = /** @type {const} */ (['list_rule', 'view_rule', 'create_rule', 'update_rule', 'delete_rule'])
  const userFields = () => parseFields(s.col?.fields ?? '[]').filter((/** @type {any} */ f) => !f.system && !f.implicit)
  const editableFields = () => userFields()

  function syncFromCol() {
    ruleVals = {}
    for (const k of RULE_KEYS) ruleVals[k] = s.col[k] || ''
    renameVal = s.col.name
    fieldDraft = {}
    rowSeq = 0
    const rows = []
    for (const f of userFields()) {
      const rid = rowSeq++
      const ff = /** @type {any} */ (f)
      /** @type {any} */ const d = { name: f.name, type: f.type, required: !!ff.required, collection: ff.collection ?? '' }
      const o = ff.options ?? {}
      for (const k of TYPE_OPTS[f.type] ?? []) if (k !== 'collection' && o[k] !== undefined) d[k] = o[k]
      for (const k of LIST_OPTS) if (Array.isArray(d[k])) d[k] = d[k].join(', ')
      fieldDraft[rid] = d
      rows.push({ id: rid })
    }
    s.fieldRows = rows
  }

  api.get(`/api/v1/collections/${id}`).then((r) => {
    const d = /** @type {any} */ (r)
    if (d?.error) { s.error = d.error; return }
    s.col = d?.data ?? null
    if (s.col) { syncFromCol(); loadRecords() }
  }).catch((/** @type {any} */ e) => { s.error = e?.message || 'Failed to load' })

  // Collection names for the relation-target dropdown in the field editor.
  api.get('/api/v1/collections').then((r) => {
    s.otherCols = (/** @type {any} */ (r)?.data ?? []).map((/** @type {any} */ c) => c.name)
  }).catch(() => { /* dropdown falls back to a text input */ })

  const vectorFields = () => userFields().filter((/** @type {any} */ f) => f.type === 'vector')

  function loadRecords() {
    const q = new URLSearchParams({ perPage: String(PER_PAGE), page: String(s.page) })
    if (s.vec && vecInput.trim() && vecField) {
      q.set('nearVector', vecInput.trim())
      q.set('nearVectorField', vecField)
      q.set('nearLimit', String(Math.max(1, Number(vecLimit) || 10)))
    } else {
      const term = s.search.trim().replace(/"/g, '')
      if (term) {
        const tf = userFields().filter((/** @type {any} */ f) => ['text', 'email', 'url'].includes(f.type)).map((/** @type {any} */ f) => f.name)
        if (tf.length) q.set('filter', tf.map((f) => `${f} ~ "${term}"`).join(' || '))
      }
    }
    api.get(`/api/v1/${s.col.name}?${q}`).then((r) => {
      const d = /** @type {any} */ (r)
      s.records = d?.data ?? []
      s.totalPages = d?.totalPages ?? 1
      s.totalItems = d?.totalItems ?? (d?.data?.length ?? 0)
      s.vecInfo = d?._vector ? `${d._vector.scanned} scanned${d._vector.truncated ? ' (truncated)' : ''}` : ''
    }).catch((/** @type {any} */ e) => { s.records = []; if (s.vec) toast.error(e?.message || 'Vector search failed') })
  }
  function runVectorSearch() {
    if (!vecInput.trim()) { toast.error('Paste a query vector, e.g. [0.1, 0.2, …]'); return }
    if (!vecField) vecField = vectorFields()[0]?.name ?? ''
    s.vec = true; s.page = 1; loadRecords()
  }
  function clearVectorSearch() { s.vec = false; vecInput = ''; s.vecInfo = ''; s.page = 1; loadRecords() }
  const goPage = (/** @type {number} */ p) => { if (p >= 1 && p <= s.totalPages && p !== s.page) { s.page = p; loadRecords() } }
  const runSearch = (/** @type {string} */ t) => { s.search = t; s.page = 1; loadRecords() }

  // ── records CRUD ──
  function openForm(/** @type {any} */ rec) {
    formInit = {}; formVals = {}
    for (const f of editableFields()) {
      const v = rec ? (rec[f.name] ?? '') : ''
      formInit[f.name] = f.type === 'bool' ? !!v : v
      formVals[f.name] = formInit[f.name]
    }
    s.editing = rec ? rec.id : 'new'
  }
  function coerce() {
    /** @type {Record<string,any>} */ const out = {}
    for (const f of editableFields()) {
      let v = formVals[f.name]
      if (f.type === 'number') v = v === '' || v === null ? null : Number(v)
      else if (f.type === 'bool') v = !!v
      out[f.name] = v
    }
    return out
  }
  async function saveRecord() {
    if (s.saving) return
    s.saving = true
    try {
      if (s.editing === 'new') await api.post(`/api/v1/${s.col.name}`, coerce())
      else await api.patch(`/api/v1/${s.col.name}/${s.editing}`, coerce())
      s.editing = null; toast.success('Saved'); loadRecords()
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Save failed') } finally { s.saving = false }
  }
  async function deleteRecord(/** @type {string} */ rid) {
    if (!globalThis.confirm('Delete this record?')) return
    try { await api.delete(`/api/v1/${s.col.name}/${rid}`); toast.success('Deleted'); loadRecords() } catch (/** @type {any} */ e) { toast.error(e?.message || 'Delete failed') }
  }

  // ── per-user auth actions (auth collections) ──
  async function resetMfa(/** @type {string} */ rid) {
    if (!globalThis.confirm('Disable MFA / TOTP for this user? They will need to re-enroll.')) return
    try {
      const r = /** @type {any} */ (await api.post(`/api/v1/admin/users/${s.col.name}/${rid}/disable-mfa`, {}))
      if (r?.error) throw new Error(r.error)
      toast.success('MFA disabled for user')
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') }
  }
  async function impersonate(/** @type {string} */ rid) {
    try {
      const r = /** @type {any} */ (await api.post(`/api/v1/admin/impersonate/${s.col.name}/${rid}`, {}))
      if (r?.error) throw new Error(r.error)
      const tok = r?.data?.token
      if (!tok) throw new Error('No token returned')
      await navigator.clipboard?.writeText(tok)
      toast.success('Impersonation token copied — use it as this user’s Bearer token')
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') }
  }

  // ── record history ──
  async function openHistory(/** @type {string} */ rid) {
    s.historyFor = rid; s.history = null
    try {
      const r = /** @type {any} */ (await api.get(`/api/v1/${s.col.name}/${rid}/history?perPage=100`))
      if (r?.error) throw new Error(r.error)
      s.history = r?.data?.data ?? []
    } catch (/** @type {any} */ e) { s.history = []; toast.error(e?.message || 'Could not load history') }
  }
  async function restoreVersion(/** @type {number} */ at) {
    if (!globalThis.confirm('Restore the record to this version? A new update will be written.')) return
    try {
      const r = /** @type {any} */ (await api.post(`/api/v1/${s.col.name}/${s.historyFor}/restore?at=${at}`, {}))
      if (r?.error) throw new Error(r.error)
      toast.success('Restored'); s.historyFor = null; loadRecords()
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Restore failed') }
  }
  /** Keys that changed between a snapshot and the older one after it in the list. */
  function changedKeys(/** @type {any[]} */ list, /** @type {number} */ i) {
    const cur = list[i]?.snapshot ?? {}
    const prev = list[i + 1]?.snapshot
    if (!prev) return new Set(Object.keys(cur))
    const keys = new Set()
    for (const k of new Set([...Object.keys(cur), ...Object.keys(prev)])) {
      if (JSON.stringify(cur[k]) !== JSON.stringify(prev[k])) keys.add(k)
    }
    return keys
  }

  // ── schema ──
  const addFieldRow = () => { const rid = rowSeq++; fieldDraft[rid] = { name: '', type: 'text', required: false }; s.fieldRows = [...s.fieldRows, { id: rid }] }
  const removeFieldRow = (/** @type {number} */ rid) => { delete fieldDraft[rid]; s.fieldRows = s.fieldRows.filter((r) => r.id !== rid) }
  async function saveSchema() {
    if (s.saving) return
    const fields = s.fieldRows.map((r) => fieldDraft[r.id]).filter((f) => f && f.name.trim()).map(fieldOut)
    s.saving = true
    try {
      const r = /** @type {any} */ (await api.patch(`/api/v1/collections/${s.col.id}`, { fields }))
      if (r?.error) throw new Error(r.error)
      if (r?.data) { s.col = r.data; syncFromCol() }
      toast.success('Schema saved'); loadRecords()
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Save failed') } finally { s.saving = false }
  }
  // ── indexes ──
  function loadIndexes() {
    api.get(`/api/v1/admin/collections/${s.col.name}/indexes`).then((r) => {
      s.indexes = /** @type {any} */ (r)?.data ?? []
    }).catch(() => { s.indexes = [] })
  }
  async function addIndex() {
    if (s.idxBusy) return
    if (!idxField) { idxField = userFields()[0]?.name ?? '' }
    if (!idxField) { toast.error('Pick a field'); return }
    s.idxBusy = true
    try {
      const r = /** @type {any} */ (await api.post(`/api/v1/admin/collections/${s.col.name}/indexes`, { field: idxField, unique: s.idxUnique }))
      if (r?.error) throw new Error(r.error)
      toast.success('Index created'); s.idxUnique = false; loadIndexes()
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Create failed') } finally { s.idxBusy = false }
  }
  async function dropIndex(/** @type {string} */ name) {
    if (!globalThis.confirm(`Drop index "${name}"?`)) return
    try {
      const r = /** @type {any} */ (await api.delete(`/api/v1/admin/collections/${s.col.name}/indexes/${name}`))
      if (r?.error) throw new Error(r.error)
      toast.success('Index dropped'); loadIndexes()
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Drop failed') }
  }

  // ── CSV ──
  async function exportCsv() {
    try { await apiDownload(`/api/v1/admin/export/${s.col.name}`, `${s.col.name}.csv`) } catch (/** @type {any} */ e) { toast.error(e?.message || 'Export failed') }
  }
  async function importCsv(/** @type {any} */ e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    s.importing = true
    try {
      const text = await file.text()
      const r = /** @type {any} */ (await apiPostText(`/api/v1/admin/import/${s.col.name}`, text))
      if (r?.error) throw new Error(r.error)
      const d = r?.data ?? {}
      if (d.failed) toast.warning(`Imported ${d.created}/${d.total} — ${d.failed} failed`)
      else toast.success(`Imported ${d.created} record${d.created === 1 ? '' : 's'}`)
      loadRecords()
    } catch (/** @type {any} */ e2) { toast.error(e2?.message || 'Import failed') } finally { s.importing = false }
  }

  async function toggleHistory() {
    try {
      const next = s.col.history_enabled ? 0 : 1
      const r = /** @type {any} */ (await api.patch(`/api/v1/collections/${s.col.id}`, { history_enabled: !!next }))
      if (r?.error) throw new Error(r.error)
      if (r?.data) { s.col = r.data }
      toast.success(next ? 'History tracking on' : 'History tracking off')
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') }
  }
  async function saveRules() {
    if (s.saving) return
    s.saving = true
    try {
      /** @type {Record<string,any>} */ const body = {}
      for (const k of RULE_KEYS) body[k] = ruleVals[k].trim() === '' ? null : ruleVals[k].trim()
      const r = /** @type {any} */ (await api.patch(`/api/v1/collections/${s.col.id}`, body))
      if (r?.error) throw new Error(r.error)
      if (r?.data) { s.col = r.data; syncFromCol() }
      toast.success('Rules saved')
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Save failed') } finally { s.saving = false }
  }
  async function renameCollection() {
    if (!renameVal.trim() || renameVal.trim() === s.col.name) return
    try {
      const r = /** @type {any} */ (await api.patch(`/api/v1/collections/${s.col.id}`, { name: renameVal.trim() }))
      if (r?.error) throw new Error(r.error)
      if (r?.data) { s.col = r.data; syncFromCol(); loadRecords() }
      toast.success('Renamed')
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Rename failed') }
  }
  async function deleteCollection() {
    if (!globalThis.confirm(`Delete collection "${s.col.name}" and ALL its records? This cannot be undone.`)) return
    try { await api.delete(`/api/v1/collections/${s.col.id}`); toast.success('Collection deleted'); router.go('/collections') } catch (/** @type {any} */ e) { toast.error(e?.message || 'Delete failed') }
  }

  const origin = () => globalThis.location.origin

  return html`
    <div class="space-y-5">
      <div>
        <button @click="${() => router.go('/collections')}" class="flex items-center gap-1 text-xs text-fg-faint hover:text-fg-soft">${Icon({ name: 'chevronLeft', size: 13 })} Data</button>
        ${() => s.error
          ? html`<h1 class="mt-2 font-display text-xl font-semibold" style="color:var(--color-bad)">${s.error}</h1>`
          : html`
            <div class="mt-2 flex flex-wrap items-center gap-3">
              <h1 class="font-display text-2xl font-semibold text-fg">${() => s.col?.name ?? '…'}</h1>
              ${() => s.col ? html`<span class="badge" style="${`color:${KIND_COLOR[s.col.type] ?? 'var(--color-brand)'}`}"><span class="dot" style="${`background:${KIND_COLOR[s.col.type] ?? 'var(--color-brand)'}`}"></span>${s.col.type}</span>` : ''}
              <span class="mono text-xs text-fg-faint">${() => (s.col ? `cw_${s.col.name} · ${s.totalItems} records` : '')}</span>
            </div>`}
      </div>

      ${() => !s.col ? '' : html`
        ${TabList({
          tabs: [
            { id: 'records', label: 'Records' },
            { id: 'fields', label: 'Fields' },
            ...(s.col.type !== 'view' ? [{ id: 'indexes', label: 'Indexes' }] : []),
            { id: 'rules', label: 'Rules' },
            { id: 'api', label: 'API' },
          ],
          active: () => s.tab,
          onSelect: (id) => { s.tab = id },
        })}

        <div role="tabpanel" aria-labelledby="${() => `tab-${s.tab}`}">
          ${() => s.tab === 'records' ? recordsTab()
            : s.tab === 'fields' ? fieldsTab()
            : s.tab === 'indexes' ? indexesTab()
            : s.tab === 'rules' ? rulesTab()
            : apiTab()}
        </div>
      `}
    </div>
  `

  function recordsTab() {
    return html`
      <div class="space-y-4">
        <div class="flex items-center gap-2">
          <div class="relative flex-1 max-w-xs">
            <span class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint">${Icon({ name: 'search', size: 14 })}</span>
            <input class="input pl-8" placeholder="Search records…" @input="${(/** @type {any} */ e) => { searchTerm = e.target.value }}" @keydown="${(/** @type {any} */ e) => { if (e.key === 'Enter') runSearch(searchTerm) }}" />
          </div>
          <span class="mono text-xs text-fg-faint">${() => `${s.totalItems} total`}</span>
          <div class="ml-auto flex items-center gap-2">
            ${vectorFields().length ? html`<button aria-pressed="${() => (s.vec ? 'true' : 'false')}" class="${() => `btn btn-sm ${s.vec ? 'btn-primary' : 'btn-secondary'}`}" @click="${() => { s.vec = !s.vec; if (!s.vec) clearVectorSearch() }}">${Icon({ name: 'ai', size: 14 })} Vector search</button>` : ''}
            ${s.col.type === 'base' ? html`<button class="btn btn-secondary btn-sm" title="Export CSV" @click="${exportCsv}">${Icon({ name: 'download', size: 14 })} Export</button>` : ''}
            ${s.col.type === 'base' ? html`<label class="btn btn-secondary btn-sm cursor-pointer" title="Import CSV">${Icon({ name: 'upload', size: 14 })} ${() => (s.importing ? 'Importing…' : 'Import')}<input type="file" accept=".csv,text/csv" class="hidden" @change="${importCsv}" /></label>` : ''}
            ${s.col.type !== 'view' ? html`<button class="btn btn-primary btn-sm" @click="${() => openForm(null)}">${Icon({ name: 'plus', size: 14 })} New record</button>` : html`<span class="badge text-fg-faint">read-only view</span>`}
          </div>
        </div>

        ${() => s.vec && vectorFields().length ? vectorPanel() : ''}
        ${() => s.editing ? recordForm() : ''}

        <div class="card overflow-hidden">
          ${() => {
            if (s.records === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
            if (!s.records.length) return html`<div class="p-8 text-center text-sm text-fg-faint">${s.search ? 'No records match.' : 'No records yet.'}</div>`
            const cols = userFields()
            const gtc = `10rem ${cols.map(() => 'minmax(9rem,1fr)').join(' ')} ${s.col.type === 'auth' ? '10rem' : '7rem'}`
            return html`
              <div class="overflow-auto" style="max-height:calc(100vh - 24rem)">
                <div class="min-w-max">
                  <div class="grid thead" style="${`grid-template-columns:${gtc}`}">
                    <div class="tcell py-2!">id</div>
                    ${cols.map((/** @type {any} */ c) => html`<div class="tcell py-2!">${c.name}</div>`.key(c.name))}
                    <div class="tcell py-2!"></div>
                  </div>
                  ${() => (s.records ?? []).map((rec) => html`
                    <div class="grid trow" style="${`grid-template-columns:${gtc}`}">
                      <div class="tcell tcell-mono truncate text-fg-faint">${String(rec.id).slice(0, 8)}</div>
                      ${cols.map((/** @type {any} */ c) => html`<div class="tcell truncate text-sm text-fg-soft">${cell(rec[c.name], c.type)}</div>`.key(c.name))}
                      <div class="tcell flex items-center justify-end gap-0.5">
                        ${s.col.type === 'auth' ? html`<button class="btn btn-ghost btn-icon" title="Impersonate (copy token)" @click="${() => impersonate(rec.id)}">${Icon({ name: 'auth', size: 14 })}</button>` : ''}
                        ${s.col.type === 'auth' ? html`<button class="btn btn-ghost btn-icon" title="Disable MFA" @click="${() => resetMfa(rec.id)}">${Icon({ name: 'key', size: 14 })}</button>` : ''}
                        ${s.col.history_enabled ? html`<button class="btn btn-ghost btn-icon" title="History" @click="${() => openHistory(rec.id)}">${Icon({ name: 'refresh', size: 14 })}</button>` : ''}
                        ${s.col.type !== 'view' ? html`<button class="btn btn-ghost btn-icon" title="Edit" @click="${() => openForm(rec)}">${Icon({ name: 'edit', size: 14 })}</button>` : ''}
                        ${s.col.type !== 'view' ? html`<button class="btn btn-ghost btn-icon" title="Delete" @click="${() => deleteRecord(rec.id)}">${Icon({ name: 'trash', size: 14 })}</button>` : ''}
                      </div>
                    </div>`.key(`${rec.id}:${rec.updated ?? ''}`))}
                </div>
              </div>
              ${() => s.totalPages > 1 ? html`
                <div class="flex items-center justify-between border-t border-line px-4 py-2.5 text-xs text-fg-faint">
                  <span>Page ${() => s.page} of ${() => s.totalPages}</span>
                  <div class="flex gap-1">
                    <button class="btn btn-secondary btn-sm" aria-disabled="${() => (s.page <= 1 ? 'true' : 'false')}" @click="${() => goPage(s.page - 1)}">${Icon({ name: 'chevronLeft', size: 13 })} Prev</button>
                    <button class="btn btn-secondary btn-sm" aria-disabled="${() => (s.page >= s.totalPages ? 'true' : 'false')}" @click="${() => goPage(s.page + 1)}">Next ${Icon({ name: 'chevronRight', size: 13 })}</button>
                  </div>
                </div>` : ''}`
          }}
        </div>

        ${() => s.historyFor ? historyPanel() : ''}
      </div>`
  }

  function vectorPanel() {
    const vf = vectorFields()
    return html`
      <div class="card card-pad space-y-3">
        <div class="flex items-center gap-2"><span class="card-title">Vector similarity search</span>${() => s.vecInfo ? html`<span class="mono text-xs text-fg-faint">${s.vecInfo}</span>` : ''}</div>
        <div class="flex flex-wrap items-end gap-2">
          <label class="flex-1 space-y-1" style="min-width:18rem"><span class="field-label">Query vector (JSON array)</span><input class="input mono" style="font-size:0.8rem" placeholder="[0.12, -0.03, 0.88, …]" @input="${(/** @type {any} */ e) => { vecInput = e.target.value }}" @keydown="${(/** @type {any} */ e) => { if (e.key === 'Enter') runVectorSearch() }}" /></label>
          <label class="space-y-1"><span class="field-label">Field</span><select class="select" style="width:10rem" @change="${(/** @type {any} */ e) => { vecField = e.target.value }}">${vf.map((/** @type {any} */ f) => html`<option value="${f.name}">${f.name} · ${f.dimensions ?? '?'}d</option>`.key(f.name))}</select></label>
          <label class="space-y-1"><span class="field-label">Top K</span><input class="input" style="width:5rem" type="number" value="10" @input="${(/** @type {any} */ e) => { vecLimit = e.target.value }}" /></label>
          <button class="btn btn-primary" @click="${runVectorSearch}">${Icon({ name: 'search', size: 14 })} Search</button>
          <button class="btn btn-ghost" @click="${clearVectorSearch}">Clear</button>
        </div>
        <p class="text-xs text-fg-faint">Ranks by cosine similarity, nearest first. Vector length must match the field's dimensions.</p>
      </div>`
  }

  function historyPanel() {
    const opColor = (/** @type {string} */ op) => op === 'create' ? 'var(--color-ok)' : op === 'delete' ? 'var(--color-bad)' : 'var(--color-info)'
    const body = html`
          <div class="max-h-[70vh] overflow-y-auto p-4">
            ${() => {
              if (s.history === null) return html`<div class="p-6 text-center text-sm text-fg-faint">Loading…</div>`
              if (!s.history.length) return html`<div class="p-6 text-center text-sm text-fg-faint">No history recorded yet.</div>`
              const list = s.history
              return html`<div class="space-y-3">${list.map((h, i) => {
                const changed = changedKeys(list, i)
                return html`
                  <div class="rounded-control border border-line">
                    <div class="flex items-center gap-2 border-b border-line px-3 py-2">
                      <span class="badge" style="${`color:${opColor(h.op)}`}"><span class="dot" style="${`background:${opColor(h.op)}`}"></span>${h.op}</span>
                      <span class="mono text-xs text-fg-faint">${new Date((h.at ?? 0) * 1000).toISOString().slice(0, 19).replace('T', ' ')}</span>
                      ${h.actor_type ? html`<span class="text-xs text-fg-faint">by ${h.actor_type}${h.actor_id ? ` ${String(h.actor_id).slice(0, 8)}` : ''}</span>` : ''}
                      ${i !== 0 && h.op !== 'delete' ? html`<button class="btn btn-secondary btn-sm ml-auto" @click="${() => restoreVersion(h.at)}">${Icon({ name: 'refresh', size: 12 })} Restore</button>` : html`<span class="ml-auto text-[10px] uppercase tracking-wide text-fg-faint">${i === 0 ? 'current' : ''}</span>`}
                    </div>
                    <div class="p-2 text-xs">
                      ${Object.keys(h.snapshot ?? {}).filter((k) => !['collectionId', 'collectionName'].includes(k)).map((k) => html`
                        <div class="${`grid grid-cols-[8rem_1fr] items-baseline gap-3 rounded px-2 py-1 ${changed.has(k) ? 'bg-brand-tint' : ''}`}">
                          <span class="mono truncate text-right text-fg-faint" title="${k}">${k}</span>
                          <span class="${`mono break-all ${changed.has(k) ? 'text-fg' : 'text-fg-soft'}`}">${(() => { const v = h.snapshot[k]; const str = v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v); return str.length > 80 ? str.slice(0, 80) + '…' : str })()}</span>
                        </div>`.key(k))}
                    </div>
                  </div>`.key(h.id ?? i)
              })}</div>`
            }}
          </div>`
    return Dialog({
      title: html`Record history · <span class="mono text-fg-soft">${String(s.historyFor).slice(0, 12)}</span>`,
      onClose: () => { s.historyFor = null },
      children: body,
    })
  }

  function recordForm() {
    return html`
      <div class="card card-pad space-y-3">
        <div class="card-title">${s.editing === 'new' ? 'New record' : 'Edit record'}</div>
        <div class="grid gap-3 sm:grid-cols-2">
          ${editableFields().map((/** @type {any} */ f) => html`
            <label class="block space-y-1">
              <span class="field-label">${f.name} <span class="font-normal text-fg-faint">${f.type}</span></span>
              ${f.type === 'bool'
                ? (formInit[f.name]
                    ? html`<div><input type="checkbox" checked @change="${(/** @type {any} */ e) => { formVals[f.name] = e.target.checked }}" /></div>`
                    : html`<div><input type="checkbox" @change="${(/** @type {any} */ e) => { formVals[f.name] = e.target.checked }}" /></div>`)
                : html`<input class="input" type="${f.type === 'number' ? 'number' : 'text'}" value="${formInit[f.name] ?? ''}" @input="${(/** @type {any} */ e) => { formVals[f.name] = e.target.value }}" />`}
            </label>`.key(f.name))}
        </div>
        <div class="flex gap-2">
          <button class="btn btn-primary" aria-disabled="${() => (s.saving ? 'true' : 'false')}" @click="${saveRecord}">${() => (s.saving ? 'Saving…' : 'Save')}</button>
          <button class="btn btn-ghost" @click="${() => { s.editing = null }}">Cancel</button>
        </div>
      </div>`
  }

  function fieldsTab() {
    return html`
      <div class="space-y-4">
        <div class="card card-pad flex items-center justify-between">
          <div><div class="text-sm font-medium text-fg">Track record history</div><div class="text-xs text-fg-faint">Keep a versioned diff of every change for records in this collection.</div></div>
          ${() => s.col.history_enabled
            ? html`<button class="btn btn-secondary btn-sm" @click="${toggleHistory}"><span class="dot" style="background:var(--color-ok)"></span> On</button>`
            : html`<button class="btn btn-secondary btn-sm" @click="${toggleHistory}"><span class="dot" style="background:var(--color-fg-faint)"></span> Off</button>`}
        </div>

        <div class="card">
          <div class="card-head"><span class="card-title">Fields</span><button class="btn btn-primary btn-sm" aria-disabled="${() => (s.saving ? 'true' : 'false')}" @click="${saveSchema}">${() => (s.saving ? 'Saving…' : 'Save changes')}</button></div>
          <div class="space-y-2 p-3">
          ${() => { void s.fieldsRev; return s.fieldRows.map((row) => html`
            <div class="rounded-control border border-line p-3">
              <div class="flex flex-wrap items-center gap-2">
                <input class="input flex-1" style="min-width:10rem" placeholder="field name" value="${fieldDraft[row.id]?.name ?? ''}" @input="${(/** @type {any} */ e) => { fieldDraft[row.id].name = e.target.value }}" />
                <select class="select" style="width:9rem" @change="${(/** @type {any} */ e) => { fieldDraft[row.id].type = e.target.value; s.fieldsRev++ }}">${[fieldDraft[row.id]?.type ?? 'text', ...FIELD_TYPES.filter((t) => t !== (fieldDraft[row.id]?.type ?? 'text'))].map((t) => html`<option value="${t}">${t}</option>`.key(t))}</select>
                ${fieldDraft[row.id]?.required
                  ? html`<label class="flex items-center gap-1.5 text-xs text-fg-soft"><input type="checkbox" checked @change="${(/** @type {any} */ e) => { fieldDraft[row.id].required = e.target.checked }}" />required</label>`
                  : html`<label class="flex items-center gap-1.5 text-xs text-fg-soft"><input type="checkbox" @change="${(/** @type {any} */ e) => { fieldDraft[row.id].required = e.target.checked }}" />required</label>`}
                <button class="btn btn-ghost btn-icon" title="Remove" @click="${() => removeFieldRow(row.id)}">${Icon({ name: 'trash', size: 14 })}</button>
              </div>
              <div class="mt-2 border-t border-line/60 pt-2">${fieldOptionControls(fieldDraft, row.id, s.otherCols)}</div>
            </div>`.key(`${row.id}:${fieldDraft[row.id]?.type ?? 'text'}`)) }}
          </div>
          <div class="px-3 pb-3"><button class="btn btn-secondary btn-sm" @click="${addFieldRow}">${Icon({ name: 'plus', size: 14 })} Add field</button></div>
        </div>

        <div class="card card-pad space-y-4">
          <div class="card-title" style="color:var(--color-bad)">Danger zone</div>
          <div class="flex flex-wrap items-end gap-2">
            <label class="space-y-1"><span class="field-label">Rename collection</span><input class="input" style="min-width:16rem" value="${s.col.name}" @input="${(/** @type {any} */ e) => { renameVal = e.target.value }}" /></label>
            <button class="btn btn-secondary" @click="${renameCollection}">Rename</button>
          </div>
          <div class="flex items-center justify-between rounded-control border border-line px-4 py-3">
            <div><div class="text-sm font-medium text-fg">Delete this collection</div><div class="text-xs text-fg-faint">Drops the table and all records. Irreversible.</div></div>
            <button class="btn btn-danger" @click="${deleteCollection}">${Icon({ name: 'trash', size: 14 })} Delete collection</button>
          </div>
        </div>
      </div>`
  }

  function rulesTab() {
    return html`
      <div class="card card-pad space-y-4">
        <div class="flex items-center justify-between"><span class="card-title">Access rules</span><button class="btn btn-primary btn-sm" aria-disabled="${() => (s.saving ? 'true' : 'false')}" @click="${saveRules}">${() => (s.saving ? 'Saving…' : 'Save rules')}</button></div>
        <p class="text-xs text-fg-faint">Empty = public. Use a filter expression, e.g. <span class="mono text-fg-soft">@request.auth.id != ""</span>. Leave blank for open access.</p>
        <div class="space-y-2">
          ${RULES.map(([key, label]) => html`
            <div class="flex items-center gap-3">
              <span class="w-16 shrink-0 text-sm text-fg-soft">${label}</span>
              <input class="input mono" style="font-size:0.8rem" placeholder="public — no rule" value="${ruleVals[key] ?? ''}" @input="${(/** @type {any} */ e) => { ruleVals[key] = e.target.value }}" />
            </div>`.key(key))}
        </div>
      </div>`
  }

  function indexesTab() {
    if (s.indexes === null) loadIndexes()
    const flds = userFields()
    return html`
      <div class="space-y-4">
        <div class="card card-pad space-y-3">
          <div class="card-title">Add index</div>
          <p class="text-xs text-fg-faint">Speed up filters and sorts on a field. <span class="mono text-fg-soft">unique</span> + <span class="mono text-fg-soft">full-text</span> field options already create their own indexes.</p>
          <div class="flex flex-wrap items-end gap-2">
            <label class="space-y-1"><span class="field-label">Field</span>
              <select class="select" style="width:12rem" @change="${(/** @type {any} */ e) => { idxField = e.target.value }}">
                ${flds.length ? flds.map((/** @type {any} */ f) => html`<option value="${f.name}">${f.name}</option>`.key(f.name)) : html`<option value="">no fields</option>`}
              </select>
            </label>
            ${s.idxUnique
              ? html`<label class="flex items-center gap-1.5 pb-2 text-xs text-fg-soft"><input type="checkbox" checked @change="${(/** @type {any} */ e) => { s.idxUnique = e.target.checked }}" />unique</label>`
              : html`<label class="flex items-center gap-1.5 pb-2 text-xs text-fg-soft"><input type="checkbox" @change="${(/** @type {any} */ e) => { s.idxUnique = e.target.checked }}" />unique</label>`}
            <button class="btn btn-primary" aria-disabled="${() => (s.idxBusy ? 'true' : 'false')}" @click="${addIndex}">${Icon({ name: 'plus', size: 14 })} ${() => (s.idxBusy ? 'Creating…' : 'Create index')}</button>
          </div>
        </div>

        <div class="card overflow-hidden">
          <div class="card-head"><span class="card-title">Indexes</span><button class="btn btn-ghost btn-sm" @click="${loadIndexes}">${Icon({ name: 'refresh', size: 13 })} Refresh</button></div>
          <div class="grid thead" style="grid-template-columns:2fr 1.2fr 0.6fr 5rem"><div class="tcell py-2!">Name</div><div class="tcell py-2!">Field(s)</div><div class="tcell py-2!">Unique</div><div class="tcell py-2!"></div></div>
          ${() => {
            if (s.indexes === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
            if (!s.indexes.length) return html`<div class="p-8 text-center text-sm text-fg-faint">No custom indexes yet.</div>`
            return html`<div>${s.indexes.map((ix) => html`
              <div class="grid trow items-center" style="grid-template-columns:2fr 1.2fr 0.6fr 5rem">
                <div class="tcell tcell-mono truncate text-fg" title="${ix.name}">${ix.name}</div>
                <div class="tcell tcell-mono text-fg-soft">${ix.field}</div>
                <div class="tcell">${ix.unique ? html`<span class="badge" style="color:var(--color-ok)"><span class="dot" style="background:var(--color-ok)"></span>unique</span>` : html`<span class="text-fg-faint">—</span>`}</div>
                <div class="tcell text-right"><button class="btn btn-ghost btn-icon" title="Drop" @click="${() => dropIndex(ix.name)}">${Icon({ name: 'trash', size: 14 })}</button></div>
              </div>`.key(ix.name))}</div>`
          }}
        </div>
      </div>`
  }

  function apiTab() {
    const name = s.col.name
    const eps = [
      ['GET', `/api/v1/${name}`, 'List records (filter, sort, page)'],
      ['GET', `/api/v1/${name}/:id`, 'Get one record'],
      ['POST', `/api/v1/${name}`, 'Create a record'],
      ['PATCH', `/api/v1/${name}/:id`, 'Update a record'],
      ['DELETE', `/api/v1/${name}/:id`, 'Delete a record'],
    ]
    const mcolor = (/** @type {string} */ m) => m === 'GET' ? 'var(--color-ok)' : m === 'DELETE' ? 'var(--color-bad)' : m === 'POST' ? 'var(--color-info)' : 'var(--color-warn)'
    return html`
      <div class="space-y-4">
        <div class="card overflow-hidden">
          <div class="card-head"><span class="card-title">REST endpoints · ${name}</span><span class="mono text-xs text-fg-faint">base: ${origin()}</span></div>
          <div class="grid thead" style="grid-template-columns:5rem 2fr 2fr"><div class="tcell py-2!">Method</div><div class="tcell py-2!">Path</div><div class="tcell py-2!">Description</div></div>
          ${eps.map(([m, path, desc]) => html`
            <div class="grid trow" style="grid-template-columns:5rem 2fr 2fr">
              <div class="tcell"><span class="mono text-xs font-semibold" style="${`color:${mcolor(m)}`}">${m}</span></div>
              <div class="tcell tcell-mono truncate text-fg">${path}</div>
              <div class="tcell truncate text-sm text-fg-soft">${desc}</div>
            </div>`.key(path + m))}
        </div>
        <div class="card card-pad flex items-center justify-between">
          <div><div class="text-sm font-medium text-fg">Full API reference</div><div class="text-xs text-fg-faint">cURL + SDK snippets for this collection, plus Auth, Batch, Files, Realtime & OAuth2.</div></div>
          <button class="btn btn-primary btn-sm" @click="${() => router.go(`/api-docs?c=${name}`)}">${Icon({ name: 'apidocs', size: 14 })} Open API docs</button>
        </div>
      </div>`
  }
}

export default CollectionDetail
