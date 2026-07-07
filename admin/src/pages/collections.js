import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useRouter } from '../composables/useRouter.js'
import { useToast } from '../composables/useToast.js'
import { api, parseFields } from '../lib/api.js'
import { Icon } from '../components/Icon.js'
import { FIELD_TYPES, fieldOut, fieldOptionControls } from '../lib/fieldEditor.js'

export const meta = { layout: 'menu', title: 'Data' }

/** @type {Record<string, string>} */
const KIND_COLOR = { base: 'var(--color-brand)', auth: 'var(--color-ok)', view: 'var(--color-warn)' }

function CollectionsPage() {
  useMeta({ title: 'Data · Cogworks' })
  const router = useRouter()
  const toast = useToast()

  const s = reactive(
    /** @type {{ list: any[]|null, creating: boolean, ctype: string, rows: {id:number}[], busy: boolean, rev: number }} */
    ({ list: null, creating: false, ctype: 'base', rows: [], busy: false, rev: 0 }),
  )
  let name = ''
  let viewQuery = ''
  /** @type {Record<number,any>} */ let fieldDraft = {}
  let rowSeq = 0

  const load = () => api.get('/api/v1/collections').then((r) => { s.list = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.list = [] })
  load()

  function openCreate() {
    name = ''; s.ctype = 'base'; viewQuery = 'SELECT id, created, updated FROM cw_posts'; fieldDraft = {}; rowSeq = 0
    const first = rowSeq++; fieldDraft[first] = { name: '', type: 'text', required: false }
    s.rows = [{ id: first }]; s.creating = true
  }
  const addField = () => { const id = rowSeq++; fieldDraft[id] = { name: '', type: 'text', required: false }; s.rows = [...s.rows, { id }] }
  const removeField = (/** @type {number} */ id) => { delete fieldDraft[id]; s.rows = s.rows.filter((r) => r.id !== id) }
  const colNames = () => (s.list ?? []).map((/** @type {any} */ c) => c.name)

  async function create() {
    if (s.busy) return
    if (!name.trim()) { toast.error('Collection name is required'); return }
    /** @type {any} */ const body = { name: name.trim(), type: s.ctype }
    if (s.ctype === 'view') body.view_query = viewQuery.trim()
    else body.fields = s.rows.map((r) => fieldDraft[r.id]).filter((f) => f && f.name.trim()).map(fieldOut)
    s.busy = true
    try {
      const r = /** @type {any} */ (await api.post('/api/v1/collections', body))
      if (r?.error) throw new Error(r.error)
      toast.success('Collection created'); s.creating = false; await load()
      if (r?.data?.id) router.go(`/collections/${r.data.id}`)
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Create failed') } finally { s.busy = false }
  }

  return html`
    <div class="space-y-5">
      <div class="flex items-end justify-between">
        <div>
          <h1 class="font-display text-2xl font-semibold text-fg">Data</h1>
          <p class="mt-0.5 text-sm text-fg-soft">Every collection is a real SQLite table — schema, rules, records, and a REST API.</p>
        </div>
        <button class="btn btn-primary" @click="${() => (s.creating ? (s.creating = false) : openCreate())}">${() => (s.creating ? html`Cancel` : html`${Icon({ name: 'plus', size: 15 })} New collection`)}</button>
      </div>

      ${() => s.creating ? createForm() : ''}

      <div class="card overflow-hidden">
        <div class="grid thead" style="grid-template-columns:1.8fr 0.7fr 0.6fr 0.8fr">
          <div class="tcell py-2.5!">Name</div><div class="tcell py-2.5!">Type</div><div class="tcell py-2.5!">Fields</div><div class="tcell py-2.5!">Updated</div>
        </div>
        ${() => {
          if (s.list === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
          if (!s.list.length) return html`<div class="p-8 text-center text-sm text-fg-faint">No collections yet. Create one to get started.</div>`
          return html`<div class="tscroll">${s.list.map((c) => html`
            <button class="grid trow w-full cursor-pointer items-center text-left" style="grid-template-columns:1.8fr 0.7fr 0.6fr 0.8fr" @click="${() => router.go(`/collections/${c.id}`)}">
              <div class="tcell flex items-center gap-2">
                <span class="text-fg-faint">${Icon({ name: 'data', size: 15 })}</span>
                <span class="font-medium text-fg">${c.name}</span>
              </div>
              <div class="tcell"><span class="badge" style="${`color:${KIND_COLOR[c.type] ?? 'var(--color-brand)'}`}"><span class="dot" style="${`background:${KIND_COLOR[c.type] ?? 'var(--color-brand)'}`}"></span>${c.type}</span></div>
              <div class="tcell mono text-xs text-fg-soft">${parseFields(c.fields).filter((/** @type {any} */ f) => !f.system && !f.implicit).length}</div>
              <div class="tcell mono text-xs text-fg-faint">${new Date((c.updated_at ?? 0) * 1000).toISOString().slice(0, 10)}</div>
            </button>`.key(c.id))}</div>`
        }}
      </div>
    </div>
  `

  function createForm() {
    const inputCls = 'input'
    return html`
      <div class="card card-pad space-y-4">
        <div class="card-title">New collection</div>
        <div class="grid gap-3 sm:grid-cols-[1fr_12rem]">
          <label class="space-y-1"><span class="field-label">Name</span><input class="${inputCls}" placeholder="e.g. articles" @input="${(/** @type {any} */ e) => { name = e.target.value }}" /></label>
          <label class="space-y-1"><span class="field-label">Type</span><select class="select" @change="${(/** @type {any} */ e) => { s.ctype = e.target.value }}"><option value="base">base — records</option><option value="auth">auth — users</option><option value="view">view — SQL query</option></select></label>
        </div>
        ${() => s.ctype === 'view'
          ? html`<label class="space-y-1"><span class="field-label">View query (read-only SQL)</span><textarea class="textarea mono" style="min-height:6rem;font-size:0.8rem" @input="${(/** @type {any} */ e) => { viewQuery = e.target.value }}">SELECT id, created, updated FROM cw_posts</textarea></label>`
          : html`<div class="space-y-2">
              <span class="field-label">Fields</span>
              ${() => { void s.rev; return s.rows.map((row) => html`
                <div class="rounded-control border border-line p-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <input class="input flex-1" style="min-width:10rem" placeholder="field name" value="${fieldDraft[row.id]?.name ?? ''}" @input="${(/** @type {any} */ e) => { fieldDraft[row.id].name = e.target.value }}" />
                    <select class="select" style="width:9rem" @change="${(/** @type {any} */ e) => { fieldDraft[row.id].type = e.target.value; s.rev++ }}">${[fieldDraft[row.id]?.type ?? 'text', ...FIELD_TYPES.filter((t) => t !== (fieldDraft[row.id]?.type ?? 'text'))].map((t) => html`<option value="${t}">${t}</option>`.key(t))}</select>
                    ${fieldDraft[row.id]?.required
                      ? html`<label class="flex items-center gap-1.5 text-xs text-fg-soft"><input type="checkbox" checked @change="${(/** @type {any} */ e) => { fieldDraft[row.id].required = e.target.checked }}" />required</label>`
                      : html`<label class="flex items-center gap-1.5 text-xs text-fg-soft"><input type="checkbox" @change="${(/** @type {any} */ e) => { fieldDraft[row.id].required = e.target.checked }}" />required</label>`}
                    <button class="btn btn-ghost btn-icon" title="Remove" @click="${() => removeField(row.id)}">${Icon({ name: 'trash', size: 14 })}</button>
                  </div>
                  <div class="mt-2 border-t border-line/60 pt-2">${fieldOptionControls(fieldDraft, row.id, colNames())}</div>
                </div>`.key(`${row.id}:${fieldDraft[row.id]?.type ?? 'text'}`)) }}
              <button class="btn btn-secondary btn-sm" @click="${addField}">${Icon({ name: 'plus', size: 14 })} Add field</button>
            </div>`}
        <button class="btn btn-primary" aria-disabled="${() => (s.busy ? 'true' : 'false')}" @click="${create}">${() => (s.busy ? 'Creating…' : 'Create collection')}</button>
      </div>`
  }
}

export default CollectionsPage
