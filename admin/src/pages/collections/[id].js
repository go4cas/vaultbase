import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../../framework/index.js'
import { useRoute } from '../../composables/useRoute.js'
import { useToast } from '../../composables/useToast.js'
import { api, parseFields } from '../../lib/api.js'
import { Link } from '../../components/Link.js'

export const meta = { layout: 'menu', title: 'Collection' }

/** @type {Record<string, { label: string, color: string }>} */
const KIND = {
  base: { label: 'base', color: 'var(--color-brand)' },
  auth: { label: 'auth', color: 'var(--color-ok)' },
  view: { label: 'view', color: 'var(--color-warn)' },
}

const RULES = /** @type {const} */ ([
  ['list_rule', 'List'],
  ['view_rule', 'View'],
  ['create_rule', 'Create'],
  ['update_rule', 'Update'],
  ['delete_rule', 'Delete'],
])

const FIELD_TYPES = ['text', 'number', 'bool', 'email', 'url', 'date', 'json']

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
  const id = route.params().id
  const toast = useToast()

  const s = reactive(
    /** @type {{ col: any, error: string, records: any[]|null, editing: string|null, saving: boolean, addingField: boolean, page: number, totalPages: number, totalItems: number, search: string }} */
    ({ col: null, error: '', records: null, editing: null, saving: false, addingField: false, page: 1, totalPages: 1, totalItems: 0, search: '' }),
  )
  const PER_PAGE = 20
  useMeta({ title: () => `${s.col?.name ?? 'Collection'} · Cogworks` })
  // Plain (non-reactive) form buffers so per-keystroke edits don't re-render the form.
  /** @type {Record<string, any>} */ let formInit = {}
  /** @type {Record<string, any>} */ let formVals = {}
  /** @type {Record<string, string>} */ let ruleVals = {}
  let newFieldName = ''
  let newFieldType = 'text'
  let searchTerm = ''

  const RULE_KEYS = /** @type {const} */ (['list_rule', 'view_rule', 'create_rule', 'update_rule', 'delete_rule'])
  function initRules() {
    ruleVals = {}
    for (const k of RULE_KEYS) ruleVals[k] = s.col[k] || ''
  }

  api.get(`/api/v1/collections/${id}`)
    .then((r) => {
      const d = /** @type {any} */ (r)
      if (d?.error) { s.error = d.error; return }
      s.col = d?.data ?? null
      if (s.col) { initRules(); loadRecords() }
    })
    .catch((/** @type {any} */ e) => { s.error = e?.message || 'Failed to load' })

  async function saveRules() {
    if (s.saving) return
    s.saving = true
    try {
      /** @type {Record<string, any>} */ const body = {}
      for (const k of RULE_KEYS) body[k] = ruleVals[k].trim() === '' ? null : ruleVals[k].trim()
      const r = /** @type {any} */ (await api.patch(`/api/v1/collections/${s.col.id}`, body))
      if (r?.error) throw new Error(r.error)
      if (r?.data) { s.col = r.data; initRules() }
      toast.success('Rules saved')
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Save failed')
    } finally { s.saving = false }
  }

  const userFields = () => parseFields(s.col.fields)
    .filter((/** @type {any} */ f) => !f.system && !f.implicit)
    .map((/** @type {any} */ f) => ({ name: f.name, type: f.type, ...(f.required ? { required: true } : {}) }))

  async function patchFields(/** @type {any[]} */ fields, /** @type {string} */ okMsg) {
    s.saving = true
    try {
      const r = /** @type {any} */ (await api.patch(`/api/v1/collections/${s.col.id}`, { fields }))
      if (r?.error) throw new Error(r.error)
      if (r?.data) s.col = r.data
      toast.success(okMsg)
      loadRecords()
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Schema change failed')
    } finally { s.saving = false }
  }

  async function addField() {
    if (!newFieldName.trim()) { toast.error('Field name required'); return }
    const fields = userFields()
    fields.push({ name: newFieldName.trim(), type: newFieldType })
    newFieldName = ''
    s.addingField = false
    await patchFields(fields, 'Field added')
  }

  async function removeSchemaField(/** @type {string} */ fname) {
    if (!globalThis.confirm(`Remove field "${fname}"? This drops the column and its data from cw_${s.col.name}.`)) return
    await patchFields(userFields().filter((f) => f.name !== fname), 'Field removed')
  }

  /** Editable = user fields (not system/implicit). */
  const editableFields = () => parseFields(s.col?.fields ?? '[]').filter((/** @type {any} */ f) => !f.system && !f.implicit)

  function loadRecords() {
    const q = new URLSearchParams({ perPage: String(PER_PAGE), page: String(s.page) })
    const term = s.search.trim().replace(/"/g, '')
    if (term) {
      // Contains-match across text-like fields (works without an FTS index).
      const textFields = editableFields()
        .filter((/** @type {any} */ f) => ['text', 'email', 'url', 'editor'].includes(f.type))
        .map((/** @type {any} */ f) => f.name)
      if (textFields.length) q.set('filter', textFields.map((f) => `${f} ~ "${term}"`).join(' || '))
    }
    api.get(`/api/v1/${s.col.name}?${q.toString()}`).then((r) => {
      const d = /** @type {any} */ (r)
      s.records = d?.data ?? []
      s.totalPages = d?.totalPages ?? 1
      s.totalItems = d?.totalItems ?? (d?.data?.length ?? 0)
    }).catch(() => { s.records = [] })
  }
  function goPage(/** @type {number} */ p) {
    if (p < 1 || p > s.totalPages || p === s.page) return
    s.page = p
    loadRecords()
  }
  function runSearch(/** @type {string} */ term) {
    s.search = term
    s.page = 1
    loadRecords()
  }

  function openForm(/** @type {any} */ rec) {
    formInit = {}
    formVals = {}
    for (const f of editableFields()) {
      const v = rec ? (rec[f.name] ?? '') : ''
      formInit[f.name] = f.type === 'bool' ? !!v : v
      formVals[f.name] = formInit[f.name]
    }
    s.editing = rec ? rec.id : 'new'
  }

  function coerce() {
    /** @type {Record<string, any>} */ const out = {}
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
      const body = coerce()
      if (s.editing === 'new') await api.post(`/api/v1/${s.col.name}`, body)
      else await api.patch(`/api/v1/${s.col.name}/${s.editing}`, body)
      s.editing = null
      toast.success('Saved')
      loadRecords()
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Save failed')
    } finally {
      s.saving = false
    }
  }

  async function deleteRecord(/** @type {string} */ rid) {
    if (!globalThis.confirm('Delete this record?')) return
    try { await api.delete(`/api/v1/${s.col.name}/${rid}`); toast.success('Deleted'); loadRecords() } catch (/** @type {any} */ e) { toast.error(e?.message || 'Delete failed') }
  }

  const kind = () => KIND[s.col?.type] ?? KIND.base
  const inputCls = 'w-full rounded-control border border-line bg-surface-inset px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-brand'

  return html`
    <div class="space-y-6">
      <div>
        ${Link({ to: '/collections', children: '‹ Collections', class: 'font-mono text-[11px] text-fg-faint hover:text-fg-soft' })}
        ${() =>
          s.error
            ? html`<h1 class="mt-2 font-display text-2xl font-semibold" style="color:var(--color-bad)">${s.error}</h1>`
            : html`
              <div class="mt-2 flex items-center gap-3">
                <h1 class="font-display text-2xl font-semibold text-fg">${() => s.col?.name ?? '…'}</h1>
                ${() =>
                  s.col
                    ? html`<span class="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 font-mono text-[11px]" style="${`color:${kind().color}`}">
                        <span class="h-1.5 w-1.5 rounded-full" style="${`background:${kind().color}`}"></span>${kind().label}
                      </span>`
                    : ''}
              </div>
              <p class="mt-1 font-mono text-[11px] text-fg-faint">${() => (s.col ? `cw_${s.col.name} · ${parseFields(s.col.fields).length} fields` : '')}</p>
            `}
      </div>

      ${() =>
        !s.col
          ? ''
          : html`
            <div class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
              <div class="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
                <div class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">Records ${() => (s.records ? `· ${s.totalItems}` : '')}</div>
                <div class="flex items-center gap-2">
                  <input
                    class="${`${inputCls} w-48 py-1.5`}"
                    placeholder="search…"
                    @input="${(/** @type {any} */ e) => { searchTerm = e.target.value }}"
                    @keydown="${(/** @type {any} */ e) => { if (e.key === 'Enter') runSearch(searchTerm) }}"
                  />
                  ${s.col.type !== 'view'
                    ? html`<button @click="${() => openForm(null)}" class="rounded-control bg-brand px-3 py-1.5 font-mono text-[11px] font-semibold text-[#12233f] transition hover:bg-brand-hover">+ new record</button>`
                    : html`<span class="font-mono text-[11px] text-fg-faint">read-only view</span>`}
                </div>
              </div>

              ${() =>
                s.editing
                  ? html`
                    <div class="space-y-3 border-b border-line bg-surface-inset px-4 py-4">
                      <div class="font-mono text-[11px] uppercase tracking-wider text-brand">${s.editing === 'new' ? 'New record' : 'Edit record'}</div>
                      <div class="grid gap-3 sm:grid-cols-2">
                        ${editableFields().map((/** @type {any} */ f) => html`
                          <label class="block">
                            <span class="font-mono text-[11px] text-fg-soft">${f.name} <span class="text-fg-faint">${f.type}</span></span>
                            ${f.type === 'bool'
                              ? html`<div class="mt-1"><input type="checkbox" aria-checked="${formInit[f.name] ? 'true' : 'false'}" @change="${(/** @type {any} */ e) => { formVals[f.name] = e.target.checked }}" /></div>`
                              : html`<input class="${`${inputCls} mt-1`}" type="${f.type === 'number' ? 'number' : 'text'}" value="${formInit[f.name] ?? ''}" @input="${(/** @type {any} */ e) => { formVals[f.name] = e.target.value }}" />`}
                          </label>`)}
                      </div>
                      <div class="flex gap-2">
                        <button @click="${saveRecord}" aria-disabled="${() => (s.saving ? 'true' : 'false')}" class="${() => `rounded-control px-3.5 py-2 font-mono text-xs font-semibold text-[#12233f] transition ${s.saving ? 'bg-brand/40' : 'bg-brand hover:bg-brand-hover'}`}">${() => (s.saving ? 'saving…' : 'save')}</button>
                        <button @click="${() => { s.editing = null }}" class="rounded-control border border-line px-3.5 py-2 font-mono text-xs text-fg-soft hover:bg-surface-raised">cancel</button>
                      </div>
                    </div>`
                  : ''}

              ${() => {
                if (s.records === null) return html`<div class="px-4 py-6 text-center text-fg-faint">Loading…</div>`
                if (!s.records.length) return html`<div class="px-4 py-6 text-center text-fg-faint">No records yet.</div>`
                const cols = editableFields()
                return html`
                  <div class="overflow-x-auto">
                    <div class="min-w-max">
                      <div class="flex border-b border-line font-mono text-[11px] uppercase tracking-wider text-fg-faint">
                        <div class="min-w-32 flex-1 px-4 py-2 font-medium">id</div>
                        ${cols.map((/** @type {any} */ c) => html`<div class="min-w-36 flex-1 px-4 py-2 font-medium">${c.name}</div>`.key(c.name))}
                        <div class="w-24 px-4 py-2"></div>
                      </div>
                      ${s.records.map((rec) => html`
                        <div class="flex items-center border-b border-line/60 text-xs">
                          <div class="min-w-32 flex-1 truncate px-4 py-2 font-mono text-fg-faint">${String(rec.id).slice(0, 8)}</div>
                          ${cols.map((/** @type {any} */ c) => html`<div class="min-w-36 flex-1 truncate px-4 py-2 text-fg-soft">${cell(rec[c.name], c.type)}</div>`.key(c.name))}
                          <div class="flex w-24 shrink-0 gap-1 px-4 py-2">
                            ${s.col.type !== 'view' ? html`<button @click="${() => openForm(rec)}" class="font-mono text-[11px] text-fg-faint hover:text-brand">edit</button>` : ''}
                            ${s.col.type !== 'view' ? html`<button @click="${() => deleteRecord(rec.id)}" class="font-mono text-[11px] text-fg-faint hover:text-bad">del</button>` : ''}
                          </div>
                        </div>`.key(rec.id))}
                    </div>
                  </div>`
              }}

              ${() =>
                s.records && s.totalPages > 1
                  ? html`
                    <div class="flex items-center justify-between border-t border-line px-4 py-2.5 font-mono text-[11px] text-fg-faint">
                      <span>page ${() => s.page} of ${() => s.totalPages} · ${() => s.totalItems} records</span>
                      <span class="flex gap-1">
                        <button @click="${() => goPage(s.page - 1)}" aria-disabled="${() => (s.page <= 1 ? 'true' : 'false')}" class="${() => `rounded-control border border-line px-2 py-1 ${s.page <= 1 ? 'opacity-40' : 'hover:bg-surface-inset'}`}">‹ prev</button>
                        <button @click="${() => goPage(s.page + 1)}" aria-disabled="${() => (s.page >= s.totalPages ? 'true' : 'false')}" class="${() => `rounded-control border border-line px-2 py-1 ${s.page >= s.totalPages ? 'opacity-40' : 'hover:bg-surface-inset'}`}">next ›</button>
                      </span>
                    </div>`
                  : ''}
            </div>

            <div class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
              <div class="flex items-center justify-between border-b border-line px-4 py-2.5">
                <div class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">Schema</div>
                ${s.col.type !== 'view'
                  ? html`<button @click="${() => { s.addingField = !s.addingField }}" class="font-mono text-[11px] text-brand hover:underline">${() => (s.addingField ? 'cancel' : '+ add field')}</button>`
                  : ''}
              </div>
              <div class="grid grid-cols-[1.2fr_0.8fr_1.2fr_0.3fr] border-b border-line font-mono text-[11px] uppercase tracking-wider text-fg-faint">
                <div class="px-4 py-2.5 font-medium">Field</div>
                <div class="px-4 py-2.5 font-medium">Type</div>
                <div class="px-4 py-2.5 font-medium">Flags</div>
                <div class="px-4 py-2.5"></div>
              </div>
              ${parseFields(s.col.fields).map((/** @type {any} */ f) =>
                html`
                  <div class="grid grid-cols-[1.2fr_0.8fr_1.2fr_0.3fr] items-center border-b border-line/60">
                    <div class="px-4 py-2.5 font-medium text-fg">${f.name}</div>
                    <div class="px-4 py-2.5 font-mono text-xs text-brand">${f.type}</div>
                    <div class="px-4 py-2.5">
                      <span class="flex flex-wrap gap-1.5 font-mono text-[10px] text-fg-faint">
                        ${f.required ? html`<span class="rounded border border-line px-1.5 py-0.5">required</span>` : ''}
                        ${f.system ? html`<span class="rounded border border-line px-1.5 py-0.5">system</span>` : ''}
                        ${f.collection ? html`<span class="rounded border border-line px-1.5 py-0.5">→ ${f.collection}</span>` : ''}
                      </span>
                    </div>
                    <div class="px-4 py-2.5 text-right">
                      ${!f.system && !f.implicit && s.col.type !== 'view'
                        ? html`<button @click="${() => removeSchemaField(f.name)}" class="font-mono text-[11px] text-fg-faint hover:text-bad">✕</button>`
                        : ''}
                    </div>
                  </div>
                `.key(f.name),
              )}
              ${() =>
                s.addingField
                  ? html`
                    <div class="flex items-center gap-2 border-t border-line bg-surface-inset px-4 py-3">
                      <input class="${`${inputCls} flex-1`}" placeholder="field name" @input="${(/** @type {any} */ e) => { newFieldName = e.target.value }}" />
                      <select class="${`${inputCls} w-32`}" @change="${(/** @type {any} */ e) => { newFieldType = e.target.value }}">
                        ${FIELD_TYPES.map((t) => html`<option value="${t}">${t}</option>`.key(t))}
                      </select>
                      <button @click="${addField}" aria-disabled="${() => (s.saving ? 'true' : 'false')}" class="rounded-control bg-brand px-3 py-2 font-mono text-[11px] font-semibold text-[#12233f] hover:bg-brand-hover">add</button>
                    </div>`
                  : ''}
            </div>

            <div class="rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
              <div class="flex items-center justify-between">
                <div class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">Access rules</div>
                <button @click="${saveRules}" aria-disabled="${() => (s.saving ? 'true' : 'false')}" class="${() => `rounded-control px-3 py-1.5 font-mono text-[11px] font-semibold text-[#12233f] transition ${s.saving ? 'bg-brand/40' : 'bg-brand hover:bg-brand-hover'}`}">${() => (s.saving ? 'saving…' : 'save rules')}</button>
              </div>
              <p class="mt-1 font-mono text-[10px] text-fg-faint">Empty = public. Use a filter expression, e.g. <span class="text-fg-soft">@request.auth.id != ""</span></p>
              <div class="mt-3 grid gap-2">
                ${RULES.map(([key, label]) => html`
                  <div class="flex items-center gap-3">
                    <span class="w-16 shrink-0 font-mono text-xs text-fg-soft">${label}</span>
                    <input class="${`${inputCls} flex-1 font-mono text-xs`}" placeholder="public — no rule" value="${ruleVals[key] ?? ''}" @input="${(/** @type {any} */ e) => { ruleVals[key] = e.target.value }}" />
                  </div>`.key(key))}
              </div>
            </div>
          `}
    </div>
  `
}

export default CollectionDetail
