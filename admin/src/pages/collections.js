import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useRouter } from '../composables/useRouter.js'
import { useToast } from '../composables/useToast.js'
import { api, parseFields } from '../lib/api.js'
import { Link } from '../components/Link.js'

export const meta = { layout: 'menu', title: 'Data' }

/** @type {Record<string, { label: string, color: string }>} */
const KIND = {
  base: { label: 'base', color: 'var(--color-brand)' },
  auth: { label: 'auth', color: 'var(--color-ok)' },
  view: { label: 'view', color: 'var(--color-warn)' },
}

const FIELD_TYPES = ['text', 'number', 'bool', 'email', 'url', 'date', 'json']

function CollectionsPage() {
  useMeta({ title: 'Data · Cogworks' })
  const router = useRouter()
  const toast = useToast()

  const s = reactive(
    /** @type {{ list: any[]|null, creating: boolean, rows: {id:number}[], busy: boolean }} */
    ({ list: null, creating: false, rows: [], busy: false }),
  )
  // Plain buffers so per-keystroke edits don't re-render the form.
  let name = ''
  let type = 'base'
  /** @type {Record<number, { name: string, type: string }>} */
  let fieldVals = {}
  let rowSeq = 0

  const load = () => api.get('/api/v1/collections').then((r) => { s.list = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.list = [] })
  load()

  function openCreate() {
    name = ''
    type = 'base'
    fieldVals = {}
    rowSeq = 0
    const first = rowSeq++
    fieldVals[first] = { name: '', type: 'text' }
    s.rows = [{ id: first }]
    s.creating = true
  }
  function addField() {
    const idn = rowSeq++
    fieldVals[idn] = { name: '', type: 'text' }
    s.rows = [...s.rows, { id: idn }]
  }
  function removeField(/** @type {number} */ idn) {
    delete fieldVals[idn]
    s.rows = s.rows.filter((r) => r.id !== idn)
  }

  async function create() {
    if (s.busy) return
    if (!name.trim()) { toast.error('Collection name is required'); return }
    const fields = s.rows.map((r) => fieldVals[r.id]).filter((f) => f && f.name.trim()).map((f) => ({ name: f.name.trim(), type: f.type }))
    s.busy = true
    try {
      const r = /** @type {any} */ (await api.post('/api/v1/collections', { name: name.trim(), type, fields }))
      if (r?.error) throw new Error(r.error)
      toast.success('Collection created')
      s.creating = false
      await load()
      if (r?.data?.id) router.go(`/collections/${r.data.id}`)
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Create failed')
    } finally {
      s.busy = false
    }
  }

  const inputCls = 'rounded-control border border-line bg-surface-inset px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-brand'

  return html`
    <div class="space-y-6">
      <div class="flex items-end justify-between">
        <div>
          <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">data</div>
          <h1 class="mt-1 font-display text-2xl font-semibold text-fg">Collections</h1>
          <p class="mt-1 text-sm text-fg-soft">Each collection is a real SQLite table — schema, rules, and records.</p>
        </div>
        <button @click="${() => (s.creating ? (s.creating = false) : openCreate())}" class="rounded-control bg-brand px-3.5 py-2 text-sm font-semibold text-[#12233f] shadow-panel hover:bg-brand-hover">${() => (s.creating ? 'Cancel' : 'New collection')}</button>
      </div>

      ${() =>
        s.creating
          ? html`
            <div class="space-y-4 rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
              <div class="grid gap-3 sm:grid-cols-[1fr_0.5fr]">
                <label class="block">
                  <span class="font-mono text-[11px] text-fg-soft">Name</span>
                  <input class="${`${inputCls} mt-1 w-full`}" placeholder="e.g. articles" value="${name}" @input="${(/** @type {any} */ e) => { name = e.target.value }}" />
                </label>
                <label class="block">
                  <span class="font-mono text-[11px] text-fg-soft">Type</span>
                  <select class="${`${inputCls} mt-1 w-full`}" @change="${(/** @type {any} */ e) => { type = e.target.value }}">
                    <option value="base">base</option>
                    <option value="auth">auth</option>
                  </select>
                </label>
              </div>

              <div>
                <div class="mb-2 font-mono text-[11px] uppercase tracking-wider text-fg-faint">Fields</div>
                <div class="space-y-2">
                  ${() => s.rows.map((row) => html`
                    <div class="flex items-center gap-2">
                      <input class="${`${inputCls} flex-1`}" placeholder="field name" value="${fieldVals[row.id]?.name ?? ''}" @input="${(/** @type {any} */ e) => { fieldVals[row.id].name = e.target.value }}" />
                      <select class="${`${inputCls} w-32`}" @change="${(/** @type {any} */ e) => { fieldVals[row.id].type = e.target.value }}">
                        ${FIELD_TYPES.map((t) => html`<option value="${t}">${t}</option>`.key(t))}
                      </select>
                      <button @click="${() => removeField(row.id)}" class="rounded-control border border-line px-2.5 py-2 font-mono text-[11px] text-fg-faint hover:border-bad hover:text-bad">✕</button>
                    </div>`.key(row.id))}
                </div>
                <button @click="${addField}" class="mt-2 font-mono text-[11px] text-brand hover:underline">+ add field</button>
              </div>

              <button @click="${create}" aria-disabled="${() => (s.busy ? 'true' : 'false')}" class="${() => `rounded-control px-4 py-2 text-sm font-semibold text-[#12233f] transition ${s.busy ? 'bg-brand/40' : 'bg-brand hover:bg-brand-hover'}`}">${() => (s.busy ? 'creating…' : 'Create collection')}</button>
            </div>`
          : ''}

      <div class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
        <div class="grid grid-cols-[1.6fr_0.8fr_0.6fr_1fr] border-b border-line font-mono text-[11px] uppercase tracking-wider text-fg-faint">
          <div class="px-4 py-3 font-medium">Name</div>
          <div class="px-4 py-3 font-medium">Kind</div>
          <div class="px-4 py-3 font-medium">Fields</div>
          <div class="px-4 py-3 font-medium">Updated</div>
        </div>
        ${() => {
          if (s.list === null) return html`<div class="px-4 py-6 text-center text-sm text-fg-faint">Loading…</div>`
          if (s.list.length === 0) return html`<div class="px-4 py-6 text-center text-sm text-fg-faint">No collections yet.</div>`
          return html`<div>
            ${s.list.map((c) => {
              const k = KIND[c.type] ?? KIND.base
              return html`
                <div class="grid grid-cols-[1.6fr_0.8fr_0.6fr_1fr] items-center border-b border-line/60 transition-colors hover:bg-surface-inset">
                  <div class="px-4 py-3">${Link({ to: `/collections/${c.id}`, children: c.name, class: 'font-medium text-fg hover:text-brand' })}</div>
                  <div class="px-4 py-3">
                    <span class="inline-flex items-center gap-1.5 rounded-full border border-line px-2 py-0.5 font-mono text-[11px]" style="${`color:${k.color}`}">
                      <span class="h-1.5 w-1.5 rounded-full" style="${`background:${k.color}`}"></span>${k.label}
                    </span>
                  </div>
                  <div class="px-4 py-3 font-mono text-xs text-fg-soft">${parseFields(c.fields).length}</div>
                  <div class="px-4 py-3 font-mono text-xs text-fg-faint">${new Date((c.updated_at ?? 0) * 1000).toISOString().slice(0, 10)}</div>
                </div>
              `.key(c.id)
            })}
          </div>`
        }}
      </div>
    </div>
  `
}

export default CollectionsPage
