import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useToast } from '../composables/useToast.js'
import { api } from '../lib/api.js'
import { Icon } from '../components/Icon.js'

export const meta = { layout: 'menu', title: 'API' }

const mcolor = (/** @type {string} */ m) =>
  m === 'GET' ? 'var(--color-ok)' : m === 'DELETE' ? 'var(--color-bad)' : m === 'POST' ? 'var(--color-info)' : 'var(--color-warn)'

function ApiDocsPage() {
  useMeta({ title: 'API · Cogworks' })
  const toast = useToast()
  const origin = globalThis.location.origin

  const s = reactive(/** @type {{ list: any[]|null, sel: string }} */ ({ list: null, sel: 'auth' }))
  api.get('/api/v1/collections').then((r) => { s.list = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.list = [] })

  const copy = (/** @type {string} */ code) => { navigator.clipboard?.writeText(code); toast.success('Copied') }

  const snippet = (/** @type {string} */ title, /** @type {string} */ code) => html`
    <div class="card overflow-hidden">
      <div class="card-head"><span class="card-title">${title}</span><button class="btn btn-ghost btn-sm" @click="${() => copy(code)}">${Icon({ name: 'copy', size: 13 })} Copy</button></div>
      <pre class="overflow-x-auto bg-surface-inset p-4 text-xs leading-relaxed text-fg-soft"><code class="mono">${code}</code></pre>
    </div>`

  const navItem = (/** @type {string} */ id, /** @type {string} */ label, /** @type {string} */ icon) => html`
    <button @click="${() => { s.sel = id }}" class="${() => `flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-sm transition-colors ${s.sel === id ? 'bg-brand-tint font-medium text-brand' : 'text-fg-soft hover:bg-surface-hover hover:text-fg'}`}">
      ${icon ? html`<span class="${() => (s.sel === id ? 'text-brand' : 'text-fg-faint')}">${Icon({ name: icon, size: 14 })}</span>` : html`<span class="mono w-4 text-center text-xs text-fg-faint">${label[0]}</span>`}
      <span class="truncate">${label}</span>
    </button>`

  return html`
    <div class="space-y-5">
      <div>
        <h1 class="font-display text-2xl font-semibold text-fg">API</h1>
        <p class="mt-0.5 text-sm text-fg-soft">Auto-generated REST reference for your Cogworks server. Base URL <span class="mono text-fg-soft">${origin}</span></p>
      </div>

      <div class="grid gap-5 lg:grid-cols-[220px_1fr]">
        <div class="space-y-4">
          <div class="space-y-0.5">
            <div class="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">Getting started</div>
            ${navItem('auth', 'Authentication', 'auth')}
          </div>
          <div class="space-y-0.5">
            <div class="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">Collections</div>
            ${() => {
              if (s.list === null) return html`<div class="px-2.5 text-xs text-fg-faint">Loading…</div>`
              if (!s.list.length) return html`<div class="px-2.5 text-xs text-fg-faint">No collections.</div>`
              return html`<div class="space-y-0.5">${s.list.map((c) => navItem(c.name, c.name, 'data'))}</div>`
            }}
          </div>
        </div>

        <div>
          ${() => (s.sel === 'auth' ? authSection() : collectionSection(s.sel))}
        </div>
      </div>
    </div>
  `

  function authSection() {
    const curl = `# Every request is authorized with an API token (Authorization: Bearer …)\ncurl ${origin}/api/v1/posts \\\n  -H "Authorization: Bearer cwat_your_token_here"`
    const js = `import Cogworks from '@cogworks/sdk'\n\n// Mint a token under Auth → API tokens, then:\nconst cw = new Cogworks('${origin}', 'cwat_your_token_here')`
    return html`
      <div class="space-y-4">
        <div class="card card-pad">
          <h2 class="font-display text-lg font-semibold text-fg">Authentication</h2>
          <p class="mt-1 text-sm text-fg-soft">Requests authenticate with an API token sent as a Bearer header. Mint scoped tokens under <span class="mono text-fg">Auth → API tokens</span>. Collection access is still gated by each collection's rules.</p>
          <div class="mt-3 flex flex-wrap gap-2 text-xs">
            ${['read', 'write', 'admin', 'mcp:read', 'mcp:write'].map((sc) => html`<span class="badge mono">${sc}</span>`)}
          </div>
        </div>
        ${snippet('cURL', curl)}
        ${snippet('JavaScript SDK', js)}
      </div>`
  }

  function collectionSection(/** @type {string} */ name) {
    const col = (s.list ?? []).find((/** @type {any} */ c) => c.name === name)
    const eps = [
      ['GET', `/api/v1/${name}`, 'List records — supports ?filter, ?sort, ?page, ?perPage, ?expand'],
      ['GET', `/api/v1/${name}/:id`, 'Fetch a single record'],
      ['POST', `/api/v1/${name}`, 'Create a record'],
      ['PATCH', `/api/v1/${name}/:id`, 'Update a record (partial)'],
      ['DELETE', `/api/v1/${name}/:id`, 'Delete a record'],
    ]
    const list = `curl "${origin}/api/v1/${name}?perPage=20&sort=-created" \\\n  -H "Authorization: Bearer <TOKEN>"`
    const create = `curl -X POST ${origin}/api/v1/${name} \\\n  -H "Authorization: Bearer <TOKEN>" \\\n  -H "Content-Type: application/json" \\\n  -d '{ "title": "Hello" }'`
    const sdk = `const cw = new Cogworks('${origin}', '<TOKEN>')\n\nconst { data } = await cw.collection('${name}').list({ page: 1, perPage: 20 })\nawait cw.collection('${name}').create({ title: 'Hello' })`
    return html`
      <div class="space-y-4">
        <div class="flex items-center gap-2">
          <h2 class="font-display text-lg font-semibold text-fg">${name}</h2>
          ${col ? html`<span class="badge mono text-fg-faint">${col.type}</span>` : ''}
        </div>
        <div class="card overflow-hidden">
          <div class="card-head"><span class="card-title">Endpoints</span></div>
          <div class="grid thead" style="grid-template-columns:5rem 2fr 3fr"><div class="tcell py-2!">Method</div><div class="tcell py-2!">Path</div><div class="tcell py-2!">Description</div></div>
          ${eps.map(([m, path, desc]) => html`
            <div class="grid trow" style="grid-template-columns:5rem 2fr 3fr">
              <div class="tcell"><span class="mono text-xs font-semibold" style="${`color:${mcolor(m)}`}">${m}</span></div>
              <div class="tcell tcell-mono truncate text-fg">${path}</div>
              <div class="tcell truncate text-sm text-fg-soft">${desc}</div>
            </div>`.key(m + path))}
        </div>
        ${snippet('List records — cURL', list)}
        ${snippet('Create a record — cURL', create)}
        ${snippet('JavaScript SDK', sdk)}
      </div>`
  }
}

export default ApiDocsPage
