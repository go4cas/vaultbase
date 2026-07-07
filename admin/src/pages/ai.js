import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useRouter } from '../composables/useRouter.js'
import { api } from '../lib/api.js'
import { Icon } from '../components/Icon.js'

export const meta = { layout: 'menu', title: 'AI' }

function AiPage() {
  useMeta({ title: 'AI · Cogworks' })
  const router = useRouter()

  const s = reactive(/** @type {{ catalog: any, clients: any[]|null }} */ ({ catalog: null, clients: null }))
  api.get('/api/v1/admin/mcp/catalog').then((r) => { s.catalog = /** @type {any} */ (r)?.data ?? {} }).catch(() => { s.catalog = {} })
  api.get('/api/v1/admin/mcp/clients').then((r) => { s.clients = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.clients = [] })

  const count = (/** @type {string} */ k) => {
    const c = s.catalog?.counts
    if (c && typeof c[k] === 'number') return c[k]
    return Array.isArray(s.catalog?.[k]) ? s.catalog[k].length : 0
  }
  const stat = (/** @type {string} */ label, /** @type {() => any} */ val) => html`
    <div class="card p-4"><div class="field-label">${label}</div><div class="mt-1 font-display text-2xl font-semibold text-fg">${val}</div></div>`

  return html`
    <div class="space-y-5">
      <div>
        <h1 class="font-display text-2xl font-semibold text-fg">AI &amp; agents</h1>
        <p class="mt-0.5 text-sm text-fg-soft">Cogworks speaks the Model Context Protocol — any agent can browse and query your data, scope-gated by API token.</p>
      </div>

      <div class="grid gap-4 sm:grid-cols-4">
        ${stat('MCP tools', () => (s.catalog === null ? '…' : count('tools')))}
        ${stat('Resources', () => (s.catalog === null ? '…' : count('resources')))}
        ${stat('Prompts', () => (s.catalog === null ? '…' : count('prompts')))}
        ${stat('Live clients', () => (s.clients === null ? '…' : s.clients.length))}
      </div>

      <div class="card card-pad">
        <div class="flex items-center gap-2"><span class="dot" style="background:var(--color-ok)"></span><span class="card-title">Connect an agent</span></div>
        <p class="mt-3 text-sm text-fg-soft">Point any MCP client at <span class="mono text-brand">/api/v1/mcp</span> with an API token carrying an <span class="mono">mcp</span> scope. Mint one under <button class="text-brand hover:underline" @click="${() => router.go('/access')}">Auth → API tokens</button>.</p>
      </div>

      <div class="card overflow-hidden">
        <div class="card-head"><span class="card-title">Tool catalog</span><span class="mono text-xs text-fg-faint">${() => (s.catalog === null ? '' : `${count('tools')} tools`)}</span></div>
        ${() => {
          const tools = s.catalog?.tools
          if (s.catalog === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
          if (!tools || !tools.length) return html`<div class="p-8 text-center text-sm text-fg-faint">No tools — create a collection to expose MCP tools.</div>`
          return html`<div>${tools.map((/** @type {any} */ t) => html`
            <div class="trow px-4 py-3">
              <div class="mono text-xs font-medium text-brand">${t.name}</div>
              <div class="mt-0.5 text-xs text-fg-soft">${t.description || ''}</div>
            </div>`.key(t.name))}</div>`
        }}
      </div>
    </div>
  `
}

export default AiPage
