import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useToast } from '../composables/useToast.js'
import { api } from '../lib/api.js'
import { CodeEditor } from '../components/CodeEditor.js'
import { Icon } from '../components/Icon.js'

export const meta = { layout: 'menu', title: 'Logic' }

const HOOK_EVENTS = ['beforeCreate', 'afterCreate', 'beforeUpdate', 'afterUpdate', 'beforeDelete', 'afterDelete']
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
/** @type {Record<string, string>} */
const STATUS_COLOR = { succeeded: 'var(--color-ok)', ok: 'var(--color-ok)', failed: 'var(--color-bad)', error: 'var(--color-bad)' }

const led = (/** @type {boolean} */ on) => html`<span class="dot" style="${`background:${on ? 'var(--color-ok)' : 'var(--color-fg-faint)'}`}"></span>`

/** @type {Record<string, any>} */
const TYPES = {
  hook: {
    label: 'Hooks', seg: 'hooks',
    title: (/** @type {any} */ i) => `${i.event} · ${i.collection_name || '—'}`,
    fresh: () => ({ collection_name: '', event: 'beforeCreate', enabled: true, code: '// ctx.record is the incoming record\n' }),
  },
  route: {
    label: 'Routes', seg: 'routes',
    title: (/** @type {any} */ i) => `${i.method} ${i.path}`,
    fresh: () => ({ name: '', method: 'GET', path: '/', enabled: true, code: 'return helpers.json({ ok: true })\n' }),
  },
  job: {
    label: 'Jobs', seg: 'jobs',
    title: (/** @type {any} */ i) => `${i.name || 'job'} · ${i.cron || 'one-off'}`,
    fresh: () => ({ name: '', cron: '0 3 * * *', enabled: true, code: 'helpers.log("running")\n' }),
  },
}

function LogicPage() {
  useMeta({ title: 'Logic · Cogworks' })
  const toast = useToast()

  const s = reactive(
    /** @type {{ type:string, hooks:any[]|null, routes:any[]|null, jobs:any[]|null, sel:any, creating:boolean, dirty:boolean, saving:boolean }} */
    ({ type: 'hook', hooks: null, routes: null, jobs: null, sel: null, creating: false, dirty: false, saving: false }),
  )
  let draft = ''
  /** @type {Record<string,any>} */ let meta = {}

  const listOf = (/** @type {string} */ t) => t === 'hook' ? s.hooks : t === 'route' ? s.routes : s.jobs
  const setList = (/** @type {string} */ t, /** @type {any} */ v) => { if (t === 'hook') s.hooks = v; else if (t === 'route') s.routes = v; else s.jobs = v }
  const load = (/** @type {string} */ t) => api.get(`/api/v1/admin/${TYPES[t].seg}`).then((r) => setList(t, /** @type {any} */ (r)?.data ?? [])).catch(() => setList(t, []))
  load('hook'); load('route'); load('job')

  function select(/** @type {any} */ item) { s.sel = item; s.creating = false; draft = item.code || ''; s.dirty = false }
  function startNew() { s.creating = true; s.sel = null; meta = TYPES[s.type].fresh(); draft = meta.code; s.dirty = false }

  async function save() {
    if (s.saving) return
    s.saving = true
    try {
      const seg = TYPES[s.type].seg
      if (s.creating) {
        const r = /** @type {any} */ (await api.post(`/api/v1/admin/${seg}`, { ...meta, code: draft }))
        if (r?.error) throw new Error(r.error)
        toast.success('Created'); s.creating = false; s.sel = r?.data ?? null; s.dirty = false
      } else {
        await api.patch(`/api/v1/admin/${seg}/${s.sel.id}`, { code: draft })
        s.sel.code = draft; s.dirty = false; toast.success('Saved')
      }
      await load(s.type)
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Save failed') } finally { s.saving = false }
  }
  async function toggleEnabled() {
    if (!s.sel) return
    const next = !s.sel.enabled
    try { await api.patch(`/api/v1/admin/${TYPES[s.type].seg}/${s.sel.id}`, { enabled: next }); s.sel.enabled = next; await load(s.type); toast.success(next ? 'Enabled' : 'Disabled') }
    catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') }
  }
  async function runJob() {
    if (!s.sel || s.type !== 'job') return
    try { await api.post(`/api/v1/admin/jobs/${s.sel.id}/run`, {}); toast.success('Job triggered'); await load('job') } catch (/** @type {any} */ e) { toast.error(e?.message || 'Run failed') }
  }
  async function remove() {
    if (!s.sel || !globalThis.confirm(`Delete this ${s.type}?`)) return
    try { await api.delete(`/api/v1/admin/${TYPES[s.type].seg}/${s.sel.id}`); s.sel = null; await load(s.type); toast.success('Deleted') } catch (/** @type {any} */ e) { toast.error(e?.message || 'Delete failed') }
  }

  const tabBtn = (/** @type {string} */ t) => html`
    <button @click="${() => { s.type = t; s.sel = null; s.creating = false }}" class="${() => `flex items-center gap-2 border-b-2 px-1 pb-2.5 pt-1 text-sm font-medium transition-colors ${s.type === t ? 'border-brand text-fg' : 'border-transparent text-fg-faint hover:text-fg-soft'}`}">
      ${TYPES[t].label}<span class="mono text-xs text-fg-faint">${() => { const l = listOf(t); return l ? l.length : '' }}</span>
    </button>`

  function rowItem(/** @type {any} */ item) {
    return html`
      <button @click="${() => select(item)}" class="${() => `flex w-full items-center gap-2.5 rounded-control px-3 py-2.5 text-left text-sm transition-colors ${s.sel?.id === item.id ? 'bg-brand-tint' : 'hover:bg-surface-hover'}`}">
        ${led(!!item.enabled)}
        <span class="${() => `min-w-0 flex-1 truncate ${s.sel?.id === item.id ? 'text-brand' : 'text-fg'}`}">${TYPES[s.type].title(item)}</span>
        ${item.last_status ? html`<span class="mono text-[10px]" style="${`color:${STATUS_COLOR[item.last_status] ?? 'var(--color-fg-faint)'}`}">${item.last_status}</span>` : ''}
      </button>`
  }

  const metaField = (/** @type {string} */ label, /** @type {any} */ control) => html`<label class="space-y-1"><span class="field-label">${label}</span>${control}</label>`

  function editorPane() {
    return html`
      <div class="flex h-full flex-col">
        <div class="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
          <span class="mono text-xs text-fg-faint">${() => (s.creating ? `new ${s.type}` : TYPES[s.type].title(s.sel))}</span>
          <div class="ml-auto flex items-center gap-1.5">
            ${() => s.creating ? '' : html`<button class="btn btn-secondary btn-sm" @click="${toggleEnabled}">${() => (s.sel.enabled ? 'Disable' : 'Enable')}</button>`}
            ${() => (s.type === 'job' && !s.creating) ? html`<button class="btn btn-secondary btn-sm" @click="${runJob}">${Icon({ name: 'play', size: 13, fill: true })} Run</button>` : ''}
            ${() => s.creating ? '' : html`<button class="btn btn-danger btn-sm" @click="${remove}">${Icon({ name: 'trash', size: 13 })}</button>`}
            <button class="btn btn-primary btn-sm" aria-disabled="${() => ((!s.dirty && !s.creating) || s.saving ? 'true' : 'false')}" @click="${save}">${() => (s.saving ? 'Saving…' : s.creating ? 'Create' : 'Save')}</button>
          </div>
        </div>
        ${() => s.creating ? html`
          <div class="grid gap-3 border-b border-line p-4 sm:grid-cols-2">
            ${s.type === 'hook' ? html`
              ${metaField('Collection', html`<input class="input" placeholder="posts" @input="${(/** @type {any} */ e) => { meta.collection_name = e.target.value }}" />`)}
              ${metaField('Event', html`<select class="select" @change="${(/** @type {any} */ e) => { meta.event = e.target.value }}">${HOOK_EVENTS.map((ev) => html`<option value="${ev}">${ev}</option>`.key(ev))}</select>`)}` : ''}
            ${s.type === 'route' ? html`
              ${metaField('Method', html`<select class="select" @change="${(/** @type {any} */ e) => { meta.method = e.target.value }}">${HTTP_METHODS.map((m) => html`<option value="${m}">${m}</option>`.key(m))}</select>`)}
              ${metaField('Path', html`<input class="input mono" value="/" @input="${(/** @type {any} */ e) => { meta.path = e.target.value }}" />`)}` : ''}
            ${s.type === 'job' ? html`
              ${metaField('Name', html`<input class="input" placeholder="nightly-cleanup" @input="${(/** @type {any} */ e) => { meta.name = e.target.value }}" />`)}
              ${metaField('Cron (UTC)', html`<input class="input mono" value="0 3 * * *" @input="${(/** @type {any} */ e) => { meta.cron = e.target.value }}" />`)}` : ''}
          </div>` : ''}
        <div class="flex-1 p-3">
          ${CodeEditor({ value: s.creating ? meta.code : (s.sel?.code || ''), language: 'javascript', height: 420, onChange: (v) => { draft = v; if (!s.dirty) s.dirty = true } })}
        </div>
      </div>`
  }

  return html`
    <div class="space-y-5">
      <div>
        <h1 class="font-display text-2xl font-semibold text-fg">Logic</h1>
        <p class="mt-0.5 text-sm text-fg-soft">Server-side JavaScript — runs on record events, HTTP requests, and schedules.</p>
      </div>

      <div class="flex gap-5 border-b border-line">${tabBtn('hook')}${tabBtn('route')}${tabBtn('job')}</div>

      <div class="grid gap-4 lg:grid-cols-[300px_1fr]">
        <div class="card flex flex-col">
          <div class="card-head"><span class="card-title">${() => TYPES[s.type].label}</span><button class="btn btn-primary btn-sm" @click="${startNew}">${Icon({ name: 'plus', size: 14 })} New</button></div>
          <div class="max-h-140 space-y-0.5 overflow-y-auto p-2">
            ${() => {
              const l = listOf(s.type)
              if (l === null) return html`<div class="p-4 text-center text-sm text-fg-faint">Loading…</div>`
              if (!l.length) return html`<div class="p-6 text-center text-sm text-fg-faint">No ${TYPES[s.type].label.toLowerCase()} yet.</div>`
              return html`<div>${l.map((item) => rowItem(item).key(item.id))}</div>`
            }}
          </div>
        </div>

        <div class="card min-h-130">
          ${() => (s.sel || s.creating) ? editorPane() : html`<div class="flex h-full min-h-120 items-center justify-center p-8 text-center text-sm text-fg-faint">Select an item to edit, or create a new one.</div>`}
        </div>
      </div>
    </div>
  `
}

export default LogicPage
