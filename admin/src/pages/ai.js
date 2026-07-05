import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { api } from '../lib/api.js'
import { Link } from '../components/Link.js'

export const meta = { layout: 'menu', title: 'AI' }

function AiPage() {
  useMeta({ title: 'AI & agents · Cogworks' })

  const s = reactive(
    /** @type {{ catalog: any, clients: any[]|null }} */
    ({ catalog: null, clients: null }),
  )

  api.get('/api/v1/admin/mcp/catalog').then((r) => { s.catalog = /** @type {any} */ (r)?.data ?? {} }).catch(() => { s.catalog = {} })
  api.get('/api/v1/admin/mcp/clients').then((r) => { s.clients = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.clients = [] })

  const count = (/** @type {string} */ k) => {
    const c = s.catalog?.counts
    if (c && typeof c[k] === 'number') return c[k]
    return Array.isArray(s.catalog?.[k]) ? s.catalog[k].length : 0
  }

  const stat = (/** @type {string} */ label, /** @type {() => any} */ val) => html`
    <div class="rounded-panel border border-line bg-surface-raised p-4 shadow-panel">
      <div class="font-mono text-[10px] uppercase tracking-wider text-fg-faint">${label}</div>
      <div class="mt-1 font-display text-2xl font-semibold text-fg">${val}</div>
    </div>`

  return html`
    <div class="space-y-8">
      <div>
        <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">ai</div>
        <h1 class="mt-1 font-display text-2xl font-semibold text-fg">AI &amp; agents</h1>
        <p class="mt-1 text-sm text-fg-soft">Cogworks speaks the Model Context Protocol. Any agent can browse and query your data — scope-gated by API token.</p>
      </div>

      <div class="grid gap-4 sm:grid-cols-4">
        ${stat('MCP tools', () => (s.catalog === null ? '…' : count('tools')))}
        ${stat('Resources', () => (s.catalog === null ? '…' : count('resources')))}
        ${stat('Prompts', () => (s.catalog === null ? '…' : count('prompts')))}
        ${stat('Live clients', () => (s.clients === null ? '…' : s.clients.length))}
      </div>

      <section class="rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
        <div class="flex items-center gap-2">
          <span class="h-2 w-2 rounded-full" style="background:var(--color-ok)"></span>
          <h2 class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">Connect an agent</h2>
        </div>
        <p class="mt-3 text-sm text-fg-soft">Point any MCP client at the server's <span class="font-mono text-brand">/api/v1/mcp</span> endpoint with an API token that carries the <span class="font-mono">mcp</span> scope. Mint one under ${Link({ to: '/access', children: 'Access', class: 'text-brand hover:underline' })}.</p>
      </section>

      <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
        <div class="border-b border-line px-4 py-3 font-mono text-[11px] uppercase tracking-wider text-fg-faint">Tool catalog</div>
        ${() => {
          const tools = s.catalog?.tools
          if (s.catalog === null) return html`<div class="px-4 py-6 text-center text-fg-faint">Loading…</div>`
          if (!tools || !tools.length) return html`<div class="px-4 py-6 text-center text-fg-faint">No tools — create a collection to expose MCP tools.</div>`
          return html`<div>${tools.map((/** @type {any} */ t) => html`
            <div class="border-b border-line/60 px-4 py-3">
              <div class="font-mono text-xs text-brand">${t.name}</div>
              <div class="mt-0.5 text-xs text-fg-soft">${t.description || ''}</div>
            </div>`.key(t.name))}</div>`
        }}
      </section>
    </div>
  `
}

export default AiPage
