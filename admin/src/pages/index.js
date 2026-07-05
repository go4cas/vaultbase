import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { api } from '../lib/api.js'
import { StatCard } from '../components/StatCard.js'

export const meta = { layout: 'menu', title: 'Overview' }

function Overview() {
  useMeta({ title: 'Overview · Cogworks' })

  const s = reactive(
    /** @type {{ collections: any[] | null, ready: boolean | null, queue: any, rt: any }} */
    ({ collections: null, ready: null, queue: null, rt: null }),
  )

  api.get('/api/v1/collections').then((r) => { s.collections = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.collections = [] })
  fetch('/_/ready').then((r) => { s.ready = r.ok }).catch(() => { s.ready = false })
  api.get('/api/v1/admin/queues/stats').then((r) => { s.queue = /** @type {any} */ (r)?.data ?? null }).catch(() => {})
  api.get('/api/v1/admin/realtime/state').then((r) => { s.rt = /** @type {any} */ (r)?.data ?? null }).catch(() => {})

  const authCount = () => (s.collections ?? []).filter((c) => c.type === 'auth').length
  const queueDepth = () => {
    const q = s.queue
    if (!q) return '—'
    if (Array.isArray(q)) return q.reduce((n, x) => n + (x.queued ?? 0), 0)
    return q.queued ?? q.depth ?? '0'
  }

  return html`
    <div class="space-y-8">
      <div>
        <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">the machine</div>
        <h1 class="mt-1 font-display text-2xl font-semibold text-fg">Overview</h1>
        <p class="mt-1 text-sm text-fg-soft">Everything the server is doing right now, at a glance.</p>
      </div>

      <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        ${StatCard({ label: 'Collections', value: () => (s.collections === null ? '…' : s.collections.length), note: () => `${authCount()} auth` })}
        ${StatCard({ label: 'Queue depth', value: queueDepth, note: () => 'jobs waiting' })}
        ${StatCard({ label: 'Realtime', value: () => (s.rt === null ? '…' : s.rt.connections), note: () => 'live connections' })}
        ${StatCard({
          label: 'Server',
          value: () => (s.ready === null ? '…' : s.ready ? 'ready' : 'down'),
          note: () => 'db + migrations',
          tone: () => (s.ready === false ? 'bad' : 'ok'),
        })}
      </div>

      <div class="rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" style="background:var(--color-ok)"></span>
          <h2 class="font-mono text-xs uppercase tracking-wider text-fg-faint">Subsystems</h2>
        </div>
        <div class="mt-4 grid gap-3 sm:grid-cols-3">
          ${['database', 'api', 'realtime', 'queues', 'search', 'mcp'].map(
            (g) => html`
              <div class="flex items-center gap-2.5 rounded-control border border-line bg-surface-inset px-3 py-2.5">
                <span class="h-1.5 w-1.5 rounded-full" style="${() => `background:${s.ready === false ? 'var(--color-bad)' : 'var(--color-ok)'}`}"></span>
                <span class="font-mono text-xs text-fg-soft">${g}</span>
                <span class="ml-auto font-mono text-[10px] text-fg-faint">${() => (s.ready === false ? 'down' : 'online')}</span>
              </div>
            `,
          )}
        </div>
      </div>
    </div>
  `
}

export default Overview
