import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { go } from '../framework/router.js'
import { api } from '../lib/api.js'
import { Icon } from '../components/Icon.js'

export const meta = { layout: 'menu', title: 'Dashboard' }

const statusColor = (/** @type {number} */ c) =>
  c >= 500 ? 'var(--color-bad)' : c >= 400 ? 'var(--color-warn)' : c >= 200 && c < 300 ? 'var(--color-ok)' : 'var(--color-fg-soft)'

const fmtUptime = (/** @type {number} */ s) => {
  if (!s) return '—'
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}
const time = (/** @type {any} */ ts) => {
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 19)
}

function Dashboard() {
  useMeta({ title: 'Dashboard · Cogworks' })

  const s = reactive(
    /** @type {{ collections: any[]|null, rt: any, queue: any, ready: any, logs: any[]|null, mcp: any, storage: any }} */
    ({ collections: null, rt: null, queue: null, ready: null, logs: null, mcp: null, storage: null }),
  )

  const load = () => {
    api.get('/api/v1/collections').then((r) => { s.collections = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.collections = [] })
    api.get('/api/v1/admin/realtime/state').then((r) => { s.rt = /** @type {any} */ (r)?.data ?? { connections: 0, topics: [] } }).catch(() => {})
    api.get('/api/v1/admin/queues/stats').then((r) => { s.queue = /** @type {any} */ (r)?.data ?? [] }).catch(() => {})
    api.get('/api/v1/admin/logs?perPage=8').then((r) => { s.logs = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.logs = [] })
    api.get('/api/v1/admin/mcp/catalog').then((r) => { s.mcp = /** @type {any} */ (r)?.data ?? {} }).catch(() => {})
    api.get('/api/v1/admin/settings/storage/status').then((r) => { s.storage = /** @type {any} */ (r)?.data ?? {} }).catch(() => {})
    fetch('/_/ready').then((r) => r.json()).then((j) => { s.ready = j?.data ?? { ready: false } }).catch(() => { s.ready = { ready: false } })
  }
  load()

  const authCount = () => (s.collections ?? []).filter((/** @type {any} */ c) => c.type === 'auth').length
  const queueDepth = () => (Array.isArray(s.queue) ? s.queue.reduce((/** @type {number} */ n, /** @type {any} */ q) => n + (q.queued ?? 0), 0) : 0)
  const mcpTools = () => (s.mcp?.counts?.tools ?? s.mcp?.tools?.length ?? 0)

  /** @param {{icon:string,label:string,value:()=>any,sub:()=>string,tone?:string}} p */
  const kpi = (p) => html`
    <div class="card p-4">
      <div class="flex items-center justify-between">
        <span class="field-label">${p.label}</span>
        <span class="flex h-7 w-7 items-center justify-center rounded-control bg-brand-tint text-brand">${Icon({ name: p.icon, size: 15 })}</span>
      </div>
      <div class="mt-2 font-display text-3xl font-semibold" style="${`color:${p.tone ?? 'var(--color-fg)'}`}">${p.value}</div>
      <div class="mt-0.5 text-xs text-fg-faint">${p.sub}</div>
    </div>`

  const metric = (/** @type {string} */ k, /** @type {()=>any} */ v) => html`
    <div class="flex items-center justify-between rounded-control bg-surface-inset px-3 py-2">
      <span class="text-xs text-fg-faint">${k}</span>
      <span class="mono text-xs font-medium text-fg">${v}</span>
    </div>`

  return html`
    <div class="space-y-6">
      <div class="flex items-end justify-between">
        <div>
          <h1 class="font-display text-2xl font-semibold text-fg">Dashboard</h1>
          <p class="mt-0.5 text-sm text-fg-soft">Everything your Cogworks server is doing, at a glance.</p>
        </div>
        <button class="btn btn-secondary btn-sm" @click="${load}">${Icon({ name: 'refresh', size: 14 })} Refresh</button>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        ${kpi({ icon: 'data', label: 'Collections', value: () => (s.collections === null ? '…' : s.collections.length), sub: () => `${authCount()} auth · ${(s.collections?.length ?? 0) - authCount()} base` })}
        ${kpi({ icon: 'realtime', label: 'Realtime', value: () => (s.rt === null ? '…' : s.rt.connections), sub: () => `${s.rt?.topics?.length ?? 0} subscriptions`, tone: 'var(--color-info)' })}
        ${kpi({ icon: 'logic', label: 'Queue', value: () => (s.queue === null ? '…' : queueDepth()), sub: () => 'jobs waiting', tone: 'var(--color-warn)' })}
        ${kpi({ icon: 'ai', label: 'MCP tools', value: () => (s.mcp === null ? '…' : mcpTools()), sub: () => 'exposed to agents', tone: 'var(--color-brand)' })}
      </div>

      <div class="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <div class="card">
          <div class="card-head"><span class="card-title">System health</span></div>
          <div class="space-y-3 p-4">
            <div class="flex items-center gap-2.5 rounded-control border px-3 py-3" style="${() => `border-color:${s.ready?.ready === false ? 'var(--color-bad)' : 'var(--color-ok)'};background:color-mix(in srgb, ${s.ready?.ready === false ? 'var(--color-bad)' : 'var(--color-ok)'} 8%, transparent)`}">
              <span class="dot" style="${() => `background:${s.ready?.ready === false ? 'var(--color-bad)' : 'var(--color-ok)'}`}"></span>
              <span class="text-sm font-semibold text-fg">${() => (s.ready === null ? 'Checking…' : s.ready.ready === false ? 'Degraded' : 'Operational')}</span>
              <span class="mono ml-auto text-xs text-fg-faint">${() => (s.ready?.readonly ? 'read-only' : '')}</span>
            </div>
            <div class="grid grid-cols-2 gap-2">
              ${metric('Uptime', () => (s.ready === null ? '…' : fmtUptime(s.ready.uptime_s)))}
              ${metric('Version', () => `v${s.ready?.schema_version ?? '0.1.0'}`)}
              ${metric('Storage', () => (s.storage === null ? '…' : (s.storage.driver ?? 'local')))}
              ${metric('Records API', () => 'REST + SDK')}
            </div>
            <div class="flex flex-wrap gap-1.5 pt-1">
              ${['database', 'api', 'realtime', 'queues', 'search', 'mcp'].map((g) => html`
                <span class="badge" style="border-color:var(--color-line)">
                  <span class="dot" style="${() => `background:${s.ready?.ready === false ? 'var(--color-bad)' : 'var(--color-ok)'}`}"></span>${g}
                </span>`)}
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <span class="card-title">Recent requests</span>
            <a href="/observe" @click="${(/** @type {Event} */ e) => { e.preventDefault(); go('/observe') }}" class="text-xs text-brand hover:underline">View all</a>
          </div>
          <div class="grid grid-cols-[auto_1fr_auto_auto] thead">
            <div class="tcell py-2!">Method</div><div class="tcell py-2!">Path</div><div class="tcell py-2! text-right">Status</div><div class="tcell py-2! text-right">Time</div>
          </div>
          ${() => {
            if (s.logs === null) return html`<div class="p-6 text-center text-sm text-fg-faint">Loading…</div>`
            if (!s.logs.length) return html`<div class="p-6 text-center text-sm text-fg-faint">No requests yet.</div>`
            return html`<div>${s.logs.map((l) => html`
              <div class="grid grid-cols-[auto_1fr_auto_auto] trow">
                <div class="tcell-mono tcell text-fg-soft">${l.method}</div>
                <div class="tcell-mono tcell truncate text-fg">${l.path}</div>
                <div class="tcell-mono tcell text-right font-semibold" style="${`color:${statusColor(l.status)}`}">${l.status}</div>
                <div class="tcell-mono tcell text-right text-fg-faint">${time(l.created_at ?? l.ts)}</div>
              </div>`.key(l.id))}</div>`
          }}
        </div>
      </div>
    </div>
  `
}

export default Dashboard
