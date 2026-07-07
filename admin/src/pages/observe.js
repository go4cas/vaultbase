import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useToast } from '../composables/useToast.js'
import { api } from '../lib/api.js'
import { Icon } from '../components/Icon.js'
import { TabList } from '../components/Tabs.js'

export const meta = { layout: 'menu', title: 'Logs' }

const statusColor = (/** @type {number} */ c) =>
  c >= 500 ? 'var(--color-bad)' : c >= 400 ? 'var(--color-warn)' : c >= 200 && c < 300 ? 'var(--color-ok)' : 'var(--color-fg-soft)'
const time = (/** @type {any} */ ts) => {
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 19)
}

function LogsPage() {
  useMeta({ title: 'Logs · Cogworks' })

  const toast = useToast()
  const s = reactive(/** @type {{ tab:string, logs: any[]|null, audit: any[]|null, queue: any, qjobs: any[]|null }} */ ({ tab: 'requests', logs: null, audit: null, queue: null, qjobs: null }))
  const load = () => {
    api.get('/api/v1/admin/logs?perPage=40').then((r) => { s.logs = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.logs = [] })
    api.get('/api/v1/admin/audit-log?perPage=25').then((r) => { s.audit = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.audit = [] })
    api.get('/api/v1/admin/queues/stats').then((r) => { s.queue = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.queue = [] })
    api.get('/api/v1/admin/queues/jobs?perPage=50').then((r) => { s.qjobs = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.qjobs = [] })
  }
  load()
  const sum = (/** @type {string} */ k) => (Array.isArray(s.queue) ? s.queue.reduce((/** @type {number} */ n, /** @type {any} */ q) => n + (q[k] ?? 0), 0) : (s.queue?.[k] ?? 0))
  const jobColor = (/** @type {string} */ st) => st === 'succeeded' ? 'var(--color-ok)' : st === 'failed' || st === 'dead' ? 'var(--color-bad)' : st === 'running' ? 'var(--color-info)' : 'var(--color-warn)'
  const retryJob = async (/** @type {string} */ id) => { try { await api.post(`/api/v1/admin/queues/jobs/${id}/retry`, {}); toast.success('Requeued'); load() } catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') } }
  const retryDead = async () => { try { const r = /** @type {any} */ (await api.post('/api/v1/admin/queues/jobs/retry-dead', {})); if (r?.error) throw new Error(r.error); toast.success('Dead-letter replayed'); load() } catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') } }

  const stat = (/** @type {string} */ label, /** @type {() => any} */ val, /** @type {string} */ color) => html`
    <div class="card p-4"><div class="field-label">${label}</div><div class="mt-1 font-display text-2xl font-semibold" style="${`color:${color}`}">${val}</div></div>`

  return html`
    <div class="space-y-5">
      <div class="flex items-end justify-between">
        <div>
          <h1 class="font-display text-2xl font-semibold text-fg">Logs</h1>
          <p class="mt-0.5 text-sm text-fg-soft">What the server is doing, and what it did.</p>
        </div>
        <button class="btn btn-secondary btn-sm" @click="${load}">${Icon({ name: 'refresh', size: 14 })} Refresh</button>
      </div>

      <div class="grid gap-4 sm:grid-cols-4">
        ${stat('Queued', () => (s.queue === null ? '…' : sum('queued')), 'var(--color-fg)')}
        ${stat('Running', () => (s.queue === null ? '…' : sum('running')), 'var(--color-ok)')}
        ${stat('Failed', () => (s.queue === null ? '…' : sum('failed')), 'var(--color-warn)')}
        ${stat('Dead', () => (s.queue === null ? '…' : sum('dead')), 'var(--color-bad)')}
      </div>

      ${TabList({
        tabs: [{ id: 'requests', label: 'Requests' }, { id: 'audit', label: 'Audit log' }, { id: 'queue', label: 'Queue' }],
        active: () => s.tab,
        onSelect: (id) => { s.tab = id },
      })}

      <div role="tabpanel" aria-labelledby="${() => `tab-${s.tab}`}" class="mt-5 space-y-5">
      ${() => s.tab === 'queue' ? html`
        <div class="card overflow-hidden">
          <div class="card-head"><span class="card-title">Queue jobs</span><button class="btn btn-secondary btn-sm" @click="${retryDead}">${Icon({ name: 'refresh', size: 13 })} Replay dead-letter</button></div>
          <div class="tscroll">
            <div class="grid thead" style="grid-template-columns:1.4fr 0.8fr 0.6fr 0.6fr 0.8fr 0.6fr"><div class="tcell py-2!">Job</div><div class="tcell py-2!">Queue</div><div class="tcell py-2!">Status</div><div class="tcell py-2!">Attempts</div><div class="tcell py-2!">Time</div><div class="tcell py-2!"></div></div>
            ${() => {
              if (s.qjobs === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
              if (!s.qjobs.length) return html`<div class="p-8 text-center text-sm text-fg-faint">Queue is empty — no jobs pending, running, or failed.</div>`
              return html`<div>${s.qjobs.map((j) => html`
                <div class="grid trow items-center" style="grid-template-columns:1.4fr 0.8fr 0.6fr 0.6fr 0.8fr 0.6fr">
                  <div class="tcell tcell-mono truncate text-fg">${j.name || j.task || String(j.id).slice(0, 8)}</div>
                  <div class="tcell tcell-mono text-fg-soft">${j.queue || 'default'}</div>
                  <div class="tcell"><span class="mono text-xs font-semibold" style="${`color:${jobColor(j.status)}`}">${j.status}</span></div>
                  <div class="tcell tcell-mono text-fg-faint">${j.attempts ?? '—'}</div>
                  <div class="tcell tcell-mono text-fg-faint">${time(j.created_at ?? j.updated_at)}</div>
                  <div class="tcell text-right">${(j.status === 'failed' || j.status === 'dead') ? html`<button class="btn btn-ghost btn-sm" @click="${() => retryJob(j.id)}">Retry</button>` : ''}</div>
                </div>`.key(j.id))}</div>`
            }}
          </div>
        </div>` : ''}

      ${() => s.tab === 'requests' ? html`
        <div class="card overflow-hidden">
          <div class="tscroll">
          <div class="grid thead" style="grid-template-columns:0.6fr 2.4fr 0.5fr 0.5fr 0.6fr">
            <div class="tcell py-2!">Method</div><div class="tcell py-2!">Path</div><div class="tcell py-2!">Status</div><div class="tcell py-2!">ms</div><div class="tcell py-2!">Time</div>
          </div>
          ${() => {
            if (s.logs === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
            if (!s.logs.length) return html`<div class="p-8 text-center text-sm text-fg-faint">No requests logged yet.</div>`
            return html`<div>${s.logs.map((l) => html`
              <div class="grid trow" style="grid-template-columns:0.6fr 2.4fr 0.5fr 0.5fr 0.6fr">
                <div class="tcell tcell-mono text-fg-soft">${l.method}</div>
                <div class="tcell tcell-mono truncate text-fg">${l.path}</div>
                <div class="tcell tcell-mono font-semibold" style="${`color:${statusColor(l.status)}`}">${l.status}</div>
                <div class="tcell tcell-mono text-fg-faint">${l.duration_ms ?? '—'}</div>
                <div class="tcell tcell-mono text-fg-faint">${time(l.created_at ?? l.ts)}</div>
              </div>`.key(l.id))}</div>`
          }}
          </div>
        </div>` : s.tab === 'audit' ? html`
        <div class="card overflow-hidden">
          <div class="tscroll">
          <div class="grid thead" style="grid-template-columns:1.2fr 1.4fr 1.4fr 0.6fr">
            <div class="tcell py-2!">Action</div><div class="tcell py-2!">Actor</div><div class="tcell py-2!">Target</div><div class="tcell py-2!">Time</div>
          </div>
          ${() => {
            if (s.audit === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
            if (!s.audit.length) return html`<div class="p-8 text-center text-sm text-fg-faint">No audit entries yet.</div>`
            return html`<div>${s.audit.map((a) => html`
              <div class="grid trow" style="grid-template-columns:1.2fr 1.4fr 1.4fr 0.6fr">
                <div class="tcell tcell-mono text-brand">${a.action || `${a.method} ${a.path}`}</div>
                <div class="tcell truncate text-sm text-fg-soft">${a.actor_email || a.actor_id || '—'}</div>
                <div class="tcell tcell-mono truncate text-fg-faint">${a.target || '—'}</div>
                <div class="tcell tcell-mono text-fg-faint">${time(a.at ?? a.created_at)}</div>
              </div>`.key(a.id))}</div>`
          }}
          </div>
        </div>` : ''}
      </div>
    </div>
  `
}

export default LogsPage
