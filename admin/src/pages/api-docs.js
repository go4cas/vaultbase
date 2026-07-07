import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useToast } from '../composables/useToast.js'
import { api, apiDownload } from '../lib/api.js'
import { Icon } from '../components/Icon.js'

export const meta = { layout: 'menu', title: 'API' }

const mcolor = (/** @type {string} */ m) =>
  m === 'GET' ? 'var(--color-ok)' : m === 'DELETE' ? 'var(--color-bad)' : m === 'POST' ? 'var(--color-info)' : 'var(--color-warn)'

function ApiDocsPage() {
  useMeta({ title: 'API · Cogworks' })
  const toast = useToast()
  const origin = globalThis.location.origin

  const s = reactive(/** @type {{ list: any[]|null, sel: string }} */ ({ list: null, sel: 'auth' }))
  api.get('/api/v1/collections').then((r) => {
    const list = /** @type {any[]} */ (/** @type {any} */ (r)?.data ?? [])
    s.list = list
    // Deep-link from a collection: /api-docs?c=<name> preselects it.
    const want = new URLSearchParams(globalThis.location.search).get('c')
    if (want && list.some((/** @type {any} */ c) => c.name === want)) s.sel = want
  }).catch(() => { s.list = [] })

  const copy = (/** @type {string} */ code) => { navigator.clipboard?.writeText(code); toast.success('Copied') }

  const snippet = (/** @type {string} */ title, /** @type {string} */ code) => html`
    <div class="card overflow-hidden">
      <div class="card-head"><span class="card-title">${title}</span><button class="btn btn-ghost btn-sm" @click="${() => copy(code)}">${Icon({ name: 'copy', size: 13 })} Copy</button></div>
      <pre class="overflow-x-auto bg-surface-inset p-4 text-xs leading-relaxed text-fg-soft"><code class="mono">${code}</code></pre>
    </div>`

  const epTable = (/** @type {[string,string,string][]} */ eps) => html`
    <div class="card overflow-hidden">
      <div class="card-head"><span class="card-title">Endpoints</span></div>
      <div class="grid thead" style="grid-template-columns:5rem 2.4fr 3fr"><div class="tcell py-2!">Method</div><div class="tcell py-2!">Path</div><div class="tcell py-2!">Description</div></div>
      ${eps.map(([m, path, desc]) => html`
        <div class="grid trow" style="grid-template-columns:5rem 2.4fr 3fr">
          <div class="tcell"><span class="mono text-xs font-semibold" style="${`color:${mcolor(m)}`}">${m}</span></div>
          <div class="tcell tcell-mono truncate text-fg" title="${path}">${path}</div>
          <div class="tcell truncate text-sm text-fg-soft" title="${desc}">${desc}</div>
        </div>`.key(m + path))}
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
            ${navItem('resources', 'Resources & SDK', 'download')}
          </div>
          <div class="space-y-0.5">
            <div class="px-2.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">Platform APIs</div>
            ${navItem('oauth2', 'OAuth2 sign-in', 'auth')}
            ${navItem('batch', 'Batch', 'logic')}
            ${navItem('files', 'Files', 'storage')}
            ${navItem('realtime', 'Realtime', 'realtime')}
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
          ${() => s.sel === 'auth' ? authSection()
            : s.sel === 'resources' ? resourcesSection()
            : s.sel === 'oauth2' ? oauth2Section()
            : s.sel === 'batch' ? batchSection()
            : s.sel === 'files' ? filesSection()
            : s.sel === 'realtime' ? realtimeSection()
            : collectionSection(s.sel)}
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

  function intro(/** @type {string} */ title, /** @type {any} */ body) {
    return html`
      <div class="card card-pad"><h2 class="font-display text-lg font-semibold text-fg">${title}</h2><p class="mt-1 text-sm text-fg-soft">${body}</p></div>`
  }

  function resourcesSection() {
    const dl = async (/** @type {string} */ path, /** @type {string} */ fn) => { try { await apiDownload(path, fn) } catch (/** @type {any} */ e) { toast.error(e?.message || 'Download failed') } }
    const resCard = (/** @type {string} */ title, /** @type {any} */ desc, /** @type {any} */ action) => html`
      <div class="card card-pad flex items-center justify-between gap-3">
        <div><div class="text-sm font-medium text-fg">${title}</div><div class="text-xs text-fg-faint">${desc}</div></div>
        ${action}
      </div>`
    return html`
      <div class="space-y-4">
        ${intro('Resources & SDK', html`Machine-readable contracts for your API — generate clients, wire up monitoring, or explore interactively. The OpenAPI surface is gated by the <span class="mono text-fg">docs.enabled</span> setting (on by default).`)}
        ${resCard('OpenAPI spec', html`The full <span class="mono text-fg">openapi.json</span> — import into Postman, Insomnia, or a codegen tool.`, html`<button class="btn btn-secondary btn-sm" @click="${() => dl('/api/v1/openapi.json', 'cogworks-openapi.json')}">${Icon({ name: 'download', size: 13 })} Download</button>`)}
        ${resCard('TypeScript SDK types', html`Generated <span class="mono text-fg">types.ts</span> matching your collections — drop into a TS project.`, html`<button class="btn btn-secondary btn-sm" @click="${() => dl('/api/v1/sdk/types.ts', 'cogworks-types.ts')}">${Icon({ name: 'download', size: 13 })} Download</button>`)}
        ${resCard('Interactive API explorer', html`Swagger UI served at <span class="mono text-fg">/api/v1/docs</span> — try endpoints in the browser.`, html`<a class="btn btn-secondary btn-sm" href="${`${origin}/api/v1/docs`}" target="_blank" rel="noopener">${Icon({ name: 'external', size: 13 })} Open</a>`)}
        ${resCard('Prometheus metrics', html`Scrape <span class="mono text-fg">${origin}/api/v1/metrics</span> for request rates, latencies, and queue depth. Enable <span class="mono text-fg">metrics.enabled</span> in Settings first.`, html`<button class="btn btn-secondary btn-sm" @click="${() => { navigator.clipboard?.writeText(`${origin}/api/v1/metrics`); toast.success('URL copied') }}">${Icon({ name: 'copy', size: 13 })} Copy URL</button>`)}
      </div>`
  }

  function oauth2Section() {
    const authCol = (s.list ?? []).find((/** @type {any} */ c) => c.type === 'auth')?.name ?? 'users'
    /** @type {[string,string,string][]} */
    const eps = [
      ['GET', `/api/v1/auth/${authCol}/oauth2/providers`, 'List enabled providers'],
      ['GET', `/api/v1/auth/${authCol}/oauth2/authorize`, 'Build an authorize URL — ?provider=&redirectUri=&state='],
      ['POST', `/api/v1/auth/${authCol}/oauth2/exchange`, 'Exchange the callback code for a session token'],
      ['POST', `/api/v1/auth/${authCol}/oauth2/merge-confirm`, 'Confirm linking when the email already exists'],
      ['DELETE', `/api/v1/auth/${authCol}/oauth2/:provider/unlink`, 'Unlink a provider from the signed-in user'],
    ]
    const flow = `# 1. Get the provider's authorize URL (server can handle PKCE)\ncurl "${origin}/api/v1/auth/${authCol}/oauth2/authorize?provider=google&redirectUri=${origin}/callback&use_pkce=1"\n# → { "data": { "authorize_url": "https://accounts.google.com/…" } }\n\n# 2. Redirect the user there. On callback, exchange the code:\ncurl -X POST ${origin}/api/v1/auth/${authCol}/oauth2/exchange \\\n  -H "Content-Type: application/json" \\\n  -d '{ "provider": "google", "code": "<code>", "redirectUri": "${origin}/callback" }'\n# → { "data": { "token": "…", "record": { "id": "…", "email": "…" } } }`
    return html`
      <div class="space-y-4">
        ${intro('OAuth2 sign-in', html`Social + OIDC login is scoped to an <span class="mono text-fg">auth</span> collection. Enable providers under <span class="mono text-fg">Auth → Configuration</span>, then run the authorize → exchange flow below. Server-side PKCE is supported via <span class="mono text-fg">use_pkce=1</span>.`)}
        ${epTable(eps)}
        ${snippet('Authorize → exchange — cURL', flow)}
      </div>`
  }

  function batchSection() {
    /** @type {[string,string,string][]} */
    const eps = [['POST', '/api/v1/batch', 'Run up to 100 writes atomically — all succeed or all roll back']]
    const body = `curl -X POST ${origin}/api/v1/batch \\\n  -H "Authorization: Bearer <TOKEN>" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "requests": [\n      { "method": "POST",  "url": "/api/v1/posts", "body": { "title": "A" } },\n      { "method": "PATCH", "url": "/api/v1/posts/abc", "body": { "title": "B" } },\n      { "method": "DELETE","url": "/api/v1/posts/xyz" }\n    ]\n  }'\n# → { "data": [ { "status": 200, "body": {…} }, … ] }  (in request order)`
    return html`
      <div class="space-y-4">
        ${intro('Batch', html`Send several writes in one transaction. Any failing request rolls back the whole batch, so partial updates never land. Responses come back in request order with each sub-status.`)}
        ${epTable(eps)}
        ${snippet('Atomic batch — cURL', body)}
      </div>`
  }

  function filesSection() {
    /** @type {[string,string,string][]} */
    const eps = [
      ['POST', '/api/v1/files/:collection/:recordId/:field', 'Upload — multipart form, field name "file"'],
      ['POST', '/api/v1/files/:collection/:recordId/:field/:filename/token', 'Mint a short-lived access token for a private file'],
      ['GET', '/api/v1/files/:filename', 'Serve bytes — ?token=… and optional ?thumb=…'],
      ['DELETE', '/api/v1/files/:collection/:recordId/:field/:filename', 'Delete one file from a field'],
    ]
    const up = `curl -X POST ${origin}/api/v1/files/posts/abc123/cover \\\n  -H "Authorization: Bearer <TOKEN>" \\\n  -F "file=@./cover.jpg"\n# → { "data": { "id": "…", "filename": "u1.jpg", "size": 20481, "mimeType": "image/jpeg" } }`
    const get = `# Private file: mint a token, then fetch\ncurl -X POST ${origin}/api/v1/files/posts/abc123/cover/u1.jpg/token \\\n  -H "Authorization: Bearer <TOKEN>"\n# → { "data": { "token": "…", "expires_at": 1730000000 } }\n\ncurl "${origin}/api/v1/files/u1.jpg?token=<FILE_TOKEN>&thumb=300x300" -o cover.jpg`
    return html`
      <div class="space-y-4">
        ${intro('Files', html`Upload to a record's <span class="mono text-fg">file</span> field with multipart form data. Private files are served via short-lived, optionally IP-bound tokens; add <span class="mono text-fg">?thumb=WxH</span> for image thumbnails.`)}
        ${epTable(eps)}
        ${snippet('Upload — cURL', up)}
        ${snippet('Access a private file — cURL', get)}
      </div>`
  }

  function realtimeSection() {
    const wsOrigin = origin.replace(/^http/, 'ws')
    /** @type {[string,string,string][]} */
    const eps = [
      ['GET', '/realtime', 'WebSocket upgrade — primary transport'],
      ['GET', '/api/v1/realtime', 'SSE stream — fallback, returns a clientId'],
      ['POST', '/api/v1/realtime', 'Set subscriptions for an SSE clientId'],
      ['GET', '/api/v1/realtime/presence/:channel', 'Snapshot of a presence channel'],
    ]
    const ws = `const ws = new WebSocket('${wsOrigin}/realtime')\n\nws.onopen = () => {\n  ws.send(JSON.stringify({ type: 'auth', token: '<TOKEN>' }))\n  // topics: "<collection>", "<collection>/<id>", "<collection>.create", or "*"\n  ws.send(JSON.stringify({ type: 'subscribe', topics: ['posts'] }))\n}\n\nws.onmessage = (e) => {\n  const msg = JSON.parse(e.data)\n  // { type: 'create'|'update', collection, record }\n  // { type: 'delete', collection, id }\n  console.log(msg)\n}`
    const sse = `// SSE fallback — no WebSocket needed\nconst es = new EventSource('${origin}/api/v1/realtime')\nlet clientId\nes.addEventListener('open', (e) => { clientId = JSON.parse(e.data).clientId })\nes.onmessage = (e) => console.log(JSON.parse(e.data))\n\n// then set subscriptions for that clientId\nawait fetch('${origin}/api/v1/realtime', {\n  method: 'POST',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({ clientId, topics: ['posts'], token: '<TOKEN>' }),\n})\n// resume after a drop with ?lastEventId=<id> or the Last-Event-ID header`
    const presence = `// Presence — track who is on a channel (WebSocket)\nws.send(JSON.stringify({ type: 'presence-track', channel: 'room:42', state: { typing: false } }))\nws.send(JSON.stringify({ type: 'presence-untrack', channel: 'room:42' }))\n\nws.onmessage = (e) => {\n  const m = JSON.parse(e.data)\n  // { type: 'presence-state', channel, state }   full snapshot\n  // { type: 'presence', channel, event: 'join'|'update'|'leave', key, state }\n}\n\n// HTTP snapshot of a channel\n// GET ${origin}/api/v1/realtime/presence/room:42`
    return html`
      <div class="space-y-4">
        ${intro('Realtime', html`Subscribe to live record changes over a WebSocket (<span class="mono text-fg">/realtime</span>) or the SSE fallback (<span class="mono text-fg">/api/v1/realtime</span>). Authenticate, subscribe to collection / per-record / event topics, and use presence channels to track who's online.`)}
        ${epTable(eps)}
        ${snippet('WebSocket — record changes', ws)}
        ${snippet('SSE fallback', sse)}
        ${snippet('Presence', presence)}
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
