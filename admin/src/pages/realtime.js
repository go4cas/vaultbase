import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useRoute } from '../composables/useRoute.js'
import { api } from '../lib/api.js'

export const meta = { layout: 'menu', title: 'Realtime' }

const CHANNELS = [
  { name: 'WebSocket', path: '/api/v1/realtime', note: 'record subscriptions + presence' },
  { name: 'SSE', path: '/api/v1/realtime/sse', note: 'server-sent event stream' },
  { name: 'Presence', path: 'presence-track', note: 'who is online, per channel' },
]

function RealtimePage() {
  useMeta({ title: 'Realtime · Cogworks' })
  const route = useRoute()

  const s = reactive(
    /** @type {{ up: boolean|null, state: any, ts: string }} */
    ({ up: null, state: null, ts: '' }),
  )

  const load = () => {
    fetch('/_/ready').then((r) => { s.up = r.ok }).catch(() => { s.up = false })
    api.get('/api/v1/admin/realtime/state')
      .then((r) => { s.state = /** @type {any} */ (r)?.data ?? { connections: 0, topics: [], presence: [] } })
      .catch(() => { s.state = { connections: 0, topics: [], presence: [] } })
  }

  // Live poll, self-stopping when we navigate away (leak-proof, no page-cleanup hook).
  const poll = () => {
    if (route.path() !== '/realtime') return
    load()
    setTimeout(poll, 4000)
  }
  poll()

  const stat = (/** @type {string} */ label, /** @type {() => any} */ val) => html`
    <div class="rounded-panel border border-line bg-surface-raised p-4 shadow-panel">
      <div class="font-mono text-[10px] uppercase tracking-wider text-fg-faint">${label}</div>
      <div class="mt-1 font-display text-2xl font-semibold text-fg">${val}</div>
    </div>`

  return html`
    <div class="space-y-8">
      <div class="flex items-end justify-between">
        <div>
          <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">realtime</div>
          <h1 class="mt-1 font-display text-2xl font-semibold text-fg">Realtime</h1>
          <p class="mt-1 text-sm text-fg-soft">Live subscriptions, presence, and events — pushed over the same binary.</p>
        </div>
        <span class="flex items-center gap-1.5 font-mono text-[10px] text-fg-faint">
          <span class="h-1.5 w-1.5 rounded-full" style="${() => `background:${s.up === false ? 'var(--color-bad)' : 'var(--color-ok)'}`}"></span>
          ${() => (s.up === null ? 'connecting…' : s.up ? 'live · 4s' : 'unreachable')}
        </span>
      </div>

      <div class="grid gap-4 sm:grid-cols-3">
        ${stat('Connections', () => (s.state === null ? '…' : s.state.connections))}
        ${stat('Subscriptions', () => (s.state === null ? '…' : (s.state.topics?.length ?? 0)))}
        ${stat('Presence channels', () => (s.state === null ? '…' : (s.state.presence?.length ?? 0)))}
      </div>

      <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
        <div class="border-b border-line px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-fg-faint">Active subscriptions</div>
        <div class="grid grid-cols-[3fr_0.6fr] border-b border-line font-mono text-[11px] uppercase tracking-wider text-fg-faint">
          <div class="px-4 py-2 font-medium">Topic</div>
          <div class="px-4 py-2 font-medium">Subs</div>
        </div>
        ${() => {
          const topics = s.state?.topics
          if (s.state === null) return html`<div class="px-4 py-6 text-center text-fg-faint">Loading…</div>`
          if (!topics || !topics.length) return html`<div class="px-4 py-6 text-center text-fg-faint">No active subscriptions.</div>`
          return html`<div>${topics.map((/** @type {any} */ t) => html`
            <div class="grid grid-cols-[3fr_0.6fr] items-center border-b border-line/60">
              <div class="truncate px-4 py-2 font-mono text-xs text-fg">${t.topic}</div>
              <div class="px-4 py-2 font-mono text-xs text-brand">${t.subscribers}</div>
            </div>`.key(t.topic))}</div>`
        }}
      </section>

      <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
        <div class="border-b border-line px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-fg-faint">Presence channels</div>
        ${() => {
          const pres = s.state?.presence
          if (s.state === null) return html`<div class="px-4 py-6 text-center text-fg-faint">Loading…</div>`
          if (!pres || !pres.length) return html`<div class="px-4 py-6 text-center text-fg-faint">Nobody present.</div>`
          return html`<div>${pres.map((/** @type {any} */ ch) => html`
            <div class="flex items-center justify-between border-b border-line/60 px-4 py-2.5">
              <span class="font-mono text-xs text-fg">${ch.channel}</span>
              <span class="font-mono text-xs text-brand">${ch.members} online</span>
            </div>`.key(ch.channel))}</div>`
        }}
      </section>

      <section class="rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
        <div class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">Transports</div>
        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          ${CHANNELS.map((ch) => html`
            <div class="rounded-control border border-line bg-surface-inset px-3 py-3">
              <div class="flex items-center gap-2">
                <span class="h-1.5 w-1.5 rounded-full" style="background:var(--color-ok)"></span>
                <span class="font-medium text-fg">${ch.name}</span>
              </div>
              <div class="mt-1.5 font-mono text-[11px] text-brand">${ch.path}</div>
              <div class="mt-0.5 text-xs text-fg-faint">${ch.note}</div>
            </div>`)}
        </div>
      </section>
    </div>
  `
}

export default RealtimePage
