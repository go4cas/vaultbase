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

  const s = reactive(/** @type {{ up: boolean|null, state: any }} */ ({ up: null, state: null }))
  const load = () => {
    fetch('/_/ready').then((r) => { s.up = r.ok }).catch(() => { s.up = false })
    api.get('/api/v1/admin/realtime/state').then((r) => { s.state = /** @type {any} */ (r)?.data ?? { connections: 0, topics: [], presence: [] } }).catch(() => { s.state = { connections: 0, topics: [], presence: [] } })
  }
  const poll = () => { if (route.path() !== '/realtime') return; load(); setTimeout(poll, 4000) }
  poll()

  const stat = (/** @type {string} */ label, /** @type {() => any} */ val, /** @type {string} */ tone = '') => html`
    <div class="card p-4"><div class="field-label">${label}</div><div class="mt-1 font-display text-2xl font-semibold" style="${`color:${tone ?? 'var(--color-fg)'}`}">${val}</div></div>`

  return html`
    <div class="space-y-5">
      <div class="flex items-end justify-between">
        <div>
          <h1 class="font-display text-2xl font-semibold text-fg">Realtime</h1>
          <p class="mt-0.5 text-sm text-fg-soft">Live subscriptions, presence, and events — pushed over the same binary.</p>
        </div>
        <span class="badge">
          <span class="dot" style="${() => `background:${s.up === false ? 'var(--color-bad)' : 'var(--color-ok)'}`}"></span>
          ${() => (s.up === null ? 'connecting…' : s.up ? 'live · 4s' : 'unreachable')}
        </span>
      </div>

      <div class="grid gap-4 sm:grid-cols-3">
        ${stat('Connections', () => (s.state === null ? '…' : s.state.connections), 'var(--color-info)')}
        ${stat('Subscriptions', () => (s.state === null ? '…' : (s.state.topics?.length ?? 0)))}
        ${stat('Presence channels', () => (s.state === null ? '…' : (s.state.presence?.length ?? 0)))}
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="card overflow-hidden">
          <div class="card-head"><span class="card-title">Active subscriptions</span></div>
          <div class="grid thead" style="grid-template-columns:3fr 0.6fr"><div class="tcell py-2!">Topic</div><div class="tcell py-2!">Subs</div></div>
          ${() => {
            const topics = s.state?.topics
            if (s.state === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
            if (!topics || !topics.length) return html`<div class="p-8 text-center text-sm text-fg-faint">No active subscriptions.</div>`
            return html`<div>${topics.map((/** @type {any} */ t) => html`
              <div class="grid trow" style="grid-template-columns:3fr 0.6fr"><div class="tcell tcell-mono truncate text-fg">${t.topic}</div><div class="tcell tcell-mono text-brand">${t.subscribers}</div></div>`.key(t.topic))}</div>`
          }}
        </div>
        <div class="card overflow-hidden">
          <div class="card-head"><span class="card-title">Presence channels</span></div>
          ${() => {
            const pres = s.state?.presence
            if (s.state === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
            if (!pres || !pres.length) return html`<div class="p-8 text-center text-sm text-fg-faint">Nobody present.</div>`
            return html`<div>${pres.map((/** @type {any} */ ch) => html`
              <div class="trow flex items-center justify-between px-4 py-2.5"><span class="mono text-xs text-fg">${ch.channel}</span><span class="mono text-xs text-brand">${ch.members} online</span></div>`.key(ch.channel))}</div>`
          }}
        </div>
      </div>

      <div class="card card-pad">
        <div class="card-title">Transports</div>
        <div class="mt-3 grid gap-3 sm:grid-cols-3">
          ${CHANNELS.map((ch) => html`
            <div class="rounded-control border border-line bg-surface-inset px-3 py-3">
              <div class="flex items-center gap-2"><span class="dot" style="background:var(--color-ok)"></span><span class="text-sm font-medium text-fg">${ch.name}</span></div>
              <div class="mt-1.5 mono text-xs text-brand">${ch.path}</div>
              <div class="mt-0.5 text-xs text-fg-faint">${ch.note}</div>
            </div>`)}
        </div>
      </div>
    </div>
  `
}

export default RealtimePage
