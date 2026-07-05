import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'

export const meta = { layout: 'menu', title: 'Realtime' }

const CHANNELS = [
  { name: 'WebSocket', path: '/api/v1/realtime', note: 'record subscriptions + presence' },
  { name: 'SSE', path: '/api/v1/realtime/sse', note: 'server-sent event stream' },
  { name: 'Presence', path: 'presence-track', note: 'who is online, per channel' },
]

function RealtimePage() {
  useMeta({ title: 'Realtime · Cogworks' })

  // Probe the server so the header LED reflects reachability.
  const s = reactive(/** @type {{ up: boolean|null }} */ ({ up: null }))
  fetch('/_/ready').then((r) => { s.up = r.ok }).catch(() => { s.up = false })

  return html`
    <div class="space-y-8">
      <div>
        <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">realtime</div>
        <h1 class="mt-1 font-display text-2xl font-semibold text-fg">Realtime</h1>
        <p class="mt-1 text-sm text-fg-soft">Live subscriptions, presence, and events — pushed over the same binary.</p>
      </div>

      <section class="rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" style="${() => `background:${s.up === false ? 'var(--color-bad)' : 'var(--color-ok)'}`}"></span>
          <h2 class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">Transports</h2>
          <span class="ml-auto font-mono text-[10px] text-fg-faint">${() => (s.up === null ? 'checking…' : s.up ? 'reachable' : 'unreachable')}</span>
        </div>
        <div class="mt-4 grid gap-3 sm:grid-cols-3">
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

      <section class="rounded-panel border border-dashed border-line-strong bg-surface-raised p-5 shadow-panel">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full" style="background:var(--color-warn)"></span>
          <span class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">live inspector</span>
        </div>
        <p class="mt-3 max-w-2xl text-sm text-fg-soft">A live view of active subscriptions, presence channels, and the event stream is the next build here — it needs a read-side admin endpoint over the socket layer. For now, subscribe from a client against the transports above.</p>
      </section>
    </div>
  `
}

export default RealtimePage
