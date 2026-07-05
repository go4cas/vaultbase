import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { api } from '../lib/api.js'

export const meta = { layout: 'menu', title: 'Observe' }

const statusColor = (/** @type {number} */ code) => {
  if (code >= 500) return 'var(--color-bad)'
  if (code >= 400) return 'var(--color-warn)'
  if (code >= 200 && code < 300) return 'var(--color-ok)'
  return 'var(--color-fg-soft)'
}
const time = (/** @type {any} */ ts) => {
  const d = typeof ts === 'number' ? new Date(ts * 1000) : new Date(ts)
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().slice(11, 19)
}

function ObservePage() {
  useMeta({ title: 'Observe · Cogworks' })

  const s = reactive(
    /** @type {{ logs: any[]|null, audit: any[]|null, queue: any }} */
    ({ logs: null, audit: null, queue: null }),
  )

  api.get('/api/v1/admin/logs?perPage=25').then((r) => { s.logs = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.logs = [] })
  api.get('/api/v1/admin/audit-log?perPage=15').then((r) => { s.audit = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.audit = [] })
  api.get('/api/v1/admin/queues/stats').then((r) => { s.queue = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.queue = [] })

  const sum = (/** @type {string} */ k) => (Array.isArray(s.queue) ? s.queue.reduce((/** @type {number} */ n, /** @type {any} */ q) => n + (q[k] ?? 0), 0) : (s.queue?.[k] ?? 0))

  const stat = (/** @type {string} */ label, /** @type {() => any} */ val, /** @type {string} */ color) => html`
    <div class="rounded-panel border border-line bg-surface-raised p-4 shadow-panel">
      <div class="font-mono text-[10px] uppercase tracking-wider text-fg-faint">${label}</div>
      <div class="mt-1 font-display text-2xl font-semibold" style="${`color:${color}`}">${val}</div>
    </div>`

  return html`
    <div class="space-y-8">
      <div>
        <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">observe</div>
        <h1 class="mt-1 font-display text-2xl font-semibold text-fg">Observe</h1>
        <p class="mt-1 text-sm text-fg-soft">What the machine is doing, and what it did.</p>
      </div>

      <div class="grid gap-4 sm:grid-cols-4">
        ${stat('Queued', () => (s.queue === null ? '…' : sum('queued')), 'var(--color-fg)')}
        ${stat('Running', () => (s.queue === null ? '…' : sum('running')), 'var(--color-ok)')}
        ${stat('Failed', () => (s.queue === null ? '…' : sum('failed')), 'var(--color-warn)')}
        ${stat('Dead', () => (s.queue === null ? '…' : sum('dead')), 'var(--color-bad)')}
      </div>

      <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
        <div class="border-b border-line px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-fg-faint">Request log</div>
        <div class="grid grid-cols-[0.6fr_2.4fr_0.5fr_0.6fr_0.6fr] border-b border-line font-mono text-[11px] uppercase tracking-wider text-fg-faint">
          <div class="px-4 py-2 font-medium">Method</div>
          <div class="px-4 py-2 font-medium">Path</div>
          <div class="px-4 py-2 font-medium">Status</div>
          <div class="px-4 py-2 font-medium">ms</div>
          <div class="px-4 py-2 font-medium">Time</div>
        </div>
        ${() => {
          if (s.logs === null) return html`<div class="px-4 py-6 text-center text-fg-faint">Loading…</div>`
          if (!s.logs.length) return html`<div class="px-4 py-6 text-center text-fg-faint">No requests logged yet.</div>`
          return html`<div>${s.logs.map((l) => html`
            <div class="grid grid-cols-[0.6fr_2.4fr_0.5fr_0.6fr_0.6fr] items-center border-b border-line/60 font-mono text-xs">
              <div class="px-4 py-2 text-fg-soft">${l.method}</div>
              <div class="truncate px-4 py-2 text-fg">${l.path}</div>
              <div class="px-4 py-2 font-semibold" style="${`color:${statusColor(l.status)}`}">${l.status}</div>
              <div class="px-4 py-2 text-fg-faint">${l.duration_ms ?? '—'}</div>
              <div class="px-4 py-2 text-fg-faint">${time(l.created_at ?? l.ts)}</div>
            </div>`.key(l.id))}</div>`
        }}
      </section>

      <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
        <div class="border-b border-line px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-fg-faint">Audit log</div>
        <div class="grid grid-cols-[1.2fr_1.4fr_1.4fr_0.6fr] border-b border-line font-mono text-[11px] uppercase tracking-wider text-fg-faint">
          <div class="px-4 py-2 font-medium">Action</div>
          <div class="px-4 py-2 font-medium">Actor</div>
          <div class="px-4 py-2 font-medium">Target</div>
          <div class="px-4 py-2 font-medium">Time</div>
        </div>
        ${() => {
          if (s.audit === null) return html`<div class="px-4 py-6 text-center text-fg-faint">Loading…</div>`
          if (!s.audit.length) return html`<div class="px-4 py-6 text-center text-fg-faint">No audit entries yet.</div>`
          return html`<div>${s.audit.map((a) => html`
            <div class="grid grid-cols-[1.2fr_1.4fr_1.4fr_0.6fr] items-center border-b border-line/60 text-xs">
              <div class="px-4 py-2 font-mono text-brand">${a.action || `${a.method} ${a.path}`}</div>
              <div class="truncate px-4 py-2 text-fg-soft">${a.actor_email || a.actor_id || '—'}</div>
              <div class="truncate px-4 py-2 font-mono text-fg-faint">${a.target || '—'}</div>
              <div class="px-4 py-2 font-mono text-fg-faint">${time(a.at ?? a.created_at)}</div>
            </div>`.key(a.id))}</div>`
        }}
      </section>
    </div>
  `
}

export default ObservePage
