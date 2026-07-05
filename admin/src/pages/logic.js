import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useToast } from '../composables/useToast.js'
import { api } from '../lib/api.js'
import { CodeEditor } from '../components/CodeEditor.js'

export const meta = { layout: 'menu', title: 'Logic' }

const led = (/** @type {boolean} */ on) =>
  html`<span class="h-1.5 w-1.5 rounded-full" style="${`background:${on ? 'var(--color-ok)' : 'var(--color-fg-faint)'}`}"></span>`

/** @type {Record<string, string>} */
const STATUS_COLOR = { ok: 'var(--color-ok)', success: 'var(--color-ok)', error: 'var(--color-bad)', failed: 'var(--color-bad)' }
/** kind → REST collection segment @type {Record<string, string>} */
const SEG = { hook: 'hooks', route: 'routes', job: 'jobs' }

function LogicPage() {
  useMeta({ title: 'Logic · Cogworks' })
  const toast = useToast()

  const s = reactive(
    /** @type {{ hooks: any[]|null, routes: any[]|null, jobs: any[]|null, sel: any, dirty: boolean, saving: boolean }} */
    ({ hooks: null, routes: null, jobs: null, sel: null, dirty: false, saving: false }),
  )
  // Kept out of reactive state so per-keystroke edits don't re-render the editor.
  let draft = ''

  const loadHooks = () => api.get('/api/v1/admin/hooks').then((r) => { s.hooks = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.hooks = [] })
  const loadRoutes = () => api.get('/api/v1/admin/routes').then((r) => { s.routes = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.routes = [] })
  const loadJobs = () => api.get('/api/v1/admin/jobs').then((r) => { s.jobs = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.jobs = [] })
  loadHooks(); loadRoutes(); loadJobs()
  /** @type {Record<string, () => Promise<void>>} */
  const reload = { hook: loadHooks, route: loadRoutes, job: loadJobs }

  /** @param {'hook'|'route'|'job'} kind @param {any} item */
  const select = (kind, item) => { s.sel = { kind, item }; draft = item.code || ''; s.dirty = false }

  async function save() {
    if (!s.sel || s.saving) return
    s.saving = true
    try {
      await api.patch(`/api/v1/admin/${SEG[s.sel.kind]}/${s.sel.item.id}`, { code: draft })
      s.sel.item.code = draft
      s.dirty = false
      toast.success('Saved')
      await reload[s.sel.kind]()
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Save failed')
    } finally {
      s.saving = false
    }
  }

  async function toggleEnabled() {
    if (!s.sel) return
    const next = !s.sel.item.enabled
    try {
      await api.patch(`/api/v1/admin/${SEG[s.sel.kind]}/${s.sel.item.id}`, { enabled: next })
      s.sel.item.enabled = next
      toast.success(next ? 'Enabled' : 'Disabled')
      await reload[s.sel.kind]()
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Failed')
    }
  }

  async function runNow() {
    if (!s.sel || s.sel.kind !== 'job') return
    try {
      await api.post(`/api/v1/admin/jobs/${s.sel.item.id}/run`, {})
      toast.success('Job triggered')
      await loadJobs()
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Run failed')
    }
  }

  async function remove() {
    if (!s.sel) return
    if (!globalThis.confirm(`Delete this ${s.sel.kind}? This cannot be undone.`)) return
    const kind = s.sel.kind
    try {
      await api.delete(`/api/v1/admin/${SEG[kind]}/${s.sel.item.id}`)
      s.sel = null
      toast.success('Deleted')
      await reload[kind]()
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Delete failed')
    }
  }

  const sectionHead = (/** @type {string} */ title, /** @type {any[]|null} */ list) => html`
    <div class="flex items-center justify-between border-b border-line px-4 py-3">
      <div class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">${title}</div>
      <span class="font-mono text-[11px] text-fg-faint">${() => (list === null ? '' : `${list.length}`)}</span>
    </div>`

  const rowBtn = (/** @type {'hook'|'route'|'job'} */ kind, /** @type {any} */ item, /** @type {any} */ children) => html`
    <button
      @click="${() => select(kind, item)}"
      class="${() => `block w-full border-b border-line/60 px-4 py-2.5 text-left transition-colors hover:bg-surface-inset ${s.sel?.item?.id === item.id ? 'bg-surface-inset' : ''}`}"
    >${children}</button>`

  const actionBtn = 'rounded-control border border-line px-2.5 py-1 font-mono text-[11px] text-fg-soft transition hover:bg-surface-inset'

  return html`
    <div class="space-y-6">
      <div>
        <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">logic</div>
        <h1 class="mt-1 font-display text-2xl font-semibold text-fg">Logic</h1>
        <p class="mt-1 text-sm text-fg-soft">Code that runs on events, requests, and schedules — click any item to edit and save.</p>
      </div>

      <div class="grid gap-6 xl:grid-cols-[1fr_1.1fr]">
        <div class="space-y-6">
          <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
            ${sectionHead('Hooks', null)}
            ${() => {
              if (s.hooks === null) return html`<div class="px-4 py-5 text-center text-fg-faint">Loading…</div>`
              if (!s.hooks.length) return html`<div class="px-4 py-5 text-center text-fg-faint">No hooks yet.</div>`
              return html`<div>${s.hooks.map((h) => rowBtn('hook', h, html`
                <span class="flex items-center gap-2.5">
                  ${() => led(!!h.enabled)}
                  <span class="font-mono text-xs text-brand">${h.event}</span>
                  <span class="text-fg">${h.collection_name || h.name || '—'}</span>
                </span>`).key(h.id))}</div>`
            }}
          </section>

          <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
            ${sectionHead('Routes', null)}
            ${() => {
              if (s.routes === null) return html`<div class="px-4 py-5 text-center text-fg-faint">Loading…</div>`
              if (!s.routes.length) return html`<div class="px-4 py-5 text-center text-fg-faint">No custom routes yet.</div>`
              return html`<div>${s.routes.map((r) => rowBtn('route', r, html`
                <span class="flex items-center gap-2.5">
                  ${() => led(!!r.enabled)}
                  <span class="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-fg-soft">${r.method}</span>
                  <span class="font-mono text-xs text-fg">${r.path}</span>
                </span>`).key(r.id))}</div>`
            }}
          </section>

          <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
            ${sectionHead('Jobs', null)}
            ${() => {
              if (s.jobs === null) return html`<div class="px-4 py-5 text-center text-fg-faint">Loading…</div>`
              if (!s.jobs.length) return html`<div class="px-4 py-5 text-center text-fg-faint">No jobs yet.</div>`
              return html`<div>${s.jobs.map((j) => rowBtn('job', j, html`
                <span class="flex items-center gap-2.5">
                  ${() => led(!!j.enabled)}
                  <span class="text-fg">${j.name || '(unnamed)'}</span>
                  <span class="font-mono text-[11px] text-fg-faint">${j.cron || 'one-off'}</span>
                  ${j.last_status ? html`<span class="ml-auto font-mono text-[10px]" style="${`color:${STATUS_COLOR[j.last_status] ?? 'var(--color-fg-faint)'}`}">${j.last_status}</span>` : ''}
                </span>`).key(j.id))}</div>`
            }}
          </section>
        </div>

        <div class="xl:sticky xl:top-20 xl:self-start">
          ${() =>
            s.sel
              ? html`
                <div class="space-y-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="font-mono text-[11px] uppercase tracking-wider text-brand">${s.sel.kind}</span>
                    <span class="font-mono text-[11px] text-fg-soft">${s.sel.item.event || s.sel.item.path || s.sel.item.name || s.sel.item.id}</span>
                    <span class="ml-auto flex items-center gap-2">
                      <button @click="${toggleEnabled}" class="${actionBtn}">${() => (s.sel.item.enabled ? 'disable' : 'enable')}</button>
                      ${() => (s.sel.kind === 'job' ? html`<button @click="${runNow}" class="${actionBtn}">run now</button>` : '')}
                      <button @click="${remove}" class="rounded-control border border-line px-2.5 py-1 font-mono text-[11px] text-fg-soft transition hover:border-bad hover:text-bad">delete</button>
                      <button
                        @click="${save}"
                        aria-disabled="${() => (!s.dirty || s.saving ? 'true' : 'false')}"
                        class="${() => `rounded-control px-3 py-1 font-mono text-[11px] font-semibold text-[#12233f] transition ${s.dirty && !s.saving ? 'bg-brand hover:bg-brand-hover' : 'cursor-not-allowed bg-brand/40'}`}"
                      >${() => (s.saving ? 'saving…' : 'save')}</button>
                    </span>
                  </div>
                  ${CodeEditor({
                    value: s.sel.item.code || '',
                    language: 'javascript',
                    height: 460,
                    onChange: (v) => { draft = v; if (!s.dirty) s.dirty = true },
                  })}
                </div>`
              : html`<div class="flex h-full min-h-[200px] items-center justify-center rounded-panel border border-dashed border-line-strong bg-surface-raised p-8 text-center font-mono text-xs text-fg-faint">Select a hook, route, or job to edit its source.</div>`}
        </div>
      </div>
    </div>
  `
}

export default LogicPage
