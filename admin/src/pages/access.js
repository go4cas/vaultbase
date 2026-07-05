import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useToast } from '../composables/useToast.js'
import { api } from '../lib/api.js'
import { Link } from '../components/Link.js'

export const meta = { layout: 'menu', title: 'Access' }

/** @type {Record<string, string>} */
const ROLE_COLOR = {
  owner: 'var(--color-brand)',
  admin: 'var(--color-ok)',
  editor: 'var(--color-warn)',
  viewer: 'var(--color-fg-faint)',
}

const SCOPES = ['read', 'write', 'admin', 'mcp:read', 'mcp:write', 'mcp:admin', 'mcp:sql']

const fmtDate = (/** @type {number} */ ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—')
const fmtExpiry = (/** @type {number} */ ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : 'never')

function AccessPage() {
  useMeta({ title: 'Access · Cogworks' })
  const toast = useToast()

  const s = reactive(
    /** @type {{ admins: any[]|null, tokens: any[]|null, authCols: any[]|null, busy: string, minting: boolean, mintName: string, mintScopes: string[], mintBusy: boolean, minted: any }} */
    ({ admins: null, tokens: null, authCols: null, busy: '', minting: false, mintName: '', mintScopes: ['read'], mintBusy: false, minted: null }),
  )

  const loadAdmins = () => api.get('/api/v1/admin/admins').then((r) => { s.admins = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.admins = [] })
  const loadTokens = () => api.get('/api/v1/admin/api-tokens').then((r) => { s.tokens = /** @type {any} */ (r)?.data ?? [] }).catch(() => { s.tokens = [] })
  const loadCols = () => api.get('/api/v1/collections').then((r) => { s.authCols = (/** @type {any} */ (r)?.data ?? []).filter((/** @type {any} */ c) => c.type === 'auth') }).catch(() => { s.authCols = [] })
  loadAdmins(); loadTokens(); loadCols()

  async function revokeToken(/** @type {string} */ id, /** @type {string} */ name) {
    if (!globalThis.confirm(`Revoke API token "${name}"? Any client using it stops working immediately.`)) return
    s.busy = id
    try { await api.delete(`/api/v1/admin/api-tokens/${id}`); await loadTokens() } finally { s.busy = '' }
  }

  const toggleScope = (/** @type {string} */ sc) => {
    s.mintScopes = s.mintScopes.includes(sc) ? s.mintScopes.filter((x) => x !== sc) : [...s.mintScopes, sc]
  }

  async function mint() {
    if (s.mintBusy) return
    if (!s.mintName.trim()) { toast.error('Name is required'); return }
    if (!s.mintScopes.length) { toast.error('Pick at least one scope'); return }
    s.mintBusy = true
    try {
      const r = /** @type {any} */ (await api.post('/api/v1/admin/api-tokens', { name: s.mintName.trim(), scopes: s.mintScopes }))
      if (r?.error) throw new Error(r.error)
      s.minted = r?.data ?? null
      s.minting = false
      s.mintName = ''
      s.mintScopes = ['read']
      await loadTokens()
      toast.success('Token minted')
    } catch (/** @type {any} */ e) {
      toast.error(e?.message || 'Mint failed')
    } finally {
      s.mintBusy = false
    }
  }

  async function copyToken() {
    try { await navigator.clipboard.writeText(s.minted.token); toast.success('Copied') } catch { toast.error('Copy failed') }
  }

  const eyebrow = (/** @type {string} */ t) => html`<div class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">${t}</div>`
  const inputCls = 'w-full rounded-control border border-line bg-surface-inset px-3 py-2 text-sm text-fg outline-none placeholder:text-fg-faint focus:border-brand'

  return html`
    <div class="space-y-8">
      <div>
        <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">access</div>
        <h1 class="mt-1 font-display text-2xl font-semibold text-fg">Access</h1>
        <p class="mt-1 text-sm text-fg-soft">Who can reach the machine — operators, tokens, and the humans in your auth collections.</p>
      </div>

      <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          ${eyebrow('Operators')}
          <span class="font-mono text-[11px] text-fg-faint">${() => (s.admins ? `${s.admins.length}` : '')}</span>
        </div>
        <div class="grid grid-cols-[2fr_0.8fr_1fr] border-b border-line font-mono text-[11px] uppercase tracking-wider text-fg-faint">
          <div class="px-4 py-2.5 font-medium">Email</div>
          <div class="px-4 py-2.5 font-medium">Role</div>
          <div class="px-4 py-2.5 font-medium">Added</div>
        </div>
        ${() => {
          if (s.admins === null) return html`<div class="px-4 py-6 text-center text-fg-faint">Loading…</div>`
          if (!s.admins.length) return html`<div class="px-4 py-6 text-center text-fg-faint">No operators.</div>`
          return html`<div>${s.admins.map((a) => html`
            <div class="grid grid-cols-[2fr_0.8fr_1fr] items-center border-b border-line/60">
              <div class="px-4 py-2.5 text-fg">${a.email}</div>
              <div class="px-4 py-2.5">
                <span class="inline-flex items-center gap-1.5 font-mono text-[11px]" style="${`color:${ROLE_COLOR[a.role] ?? 'var(--color-fg-soft)'}`}">
                  <span class="h-1.5 w-1.5 rounded-full" style="${`background:${ROLE_COLOR[a.role] ?? 'var(--color-fg-soft)'}`}"></span>${a.role}
                </span>
              </div>
              <div class="px-4 py-2.5 font-mono text-xs text-fg-faint">${fmtDate(a.created_at)}</div>
            </div>`.key(a.id ?? a.email))}</div>`
        }}
      </section>

      <section class="overflow-hidden rounded-panel border border-line bg-surface-raised text-sm shadow-panel">
        <div class="flex items-center justify-between border-b border-line px-4 py-3">
          ${eyebrow('API tokens')}
          <button @click="${() => { s.minting = !s.minting; s.minted = null }}" class="rounded-control bg-brand px-3 py-1.5 font-mono text-[11px] font-semibold text-[#12233f] transition hover:bg-brand-hover">${() => (s.minting ? 'cancel' : '+ new token')}</button>
        </div>

        ${() =>
          s.minting
            ? html`
              <div class="space-y-3 border-b border-line bg-surface-inset px-4 py-4">
                <input class="${inputCls}" placeholder="Token name (e.g. ci-deploy)" value="${() => s.mintName}" @input="${(/** @type {any} */ e) => { s.mintName = e.target.value }}" />
                <div class="flex flex-wrap gap-2">
                  ${SCOPES.map((sc) => html`
                    <button @click="${() => toggleScope(sc)}" class="${() => `rounded-control border px-2.5 py-1 font-mono text-[11px] transition ${s.mintScopes.includes(sc) ? 'border-brand bg-brand-tint text-brand' : 'border-line text-fg-soft hover:bg-surface-raised'}`}">${sc}</button>`)}
                </div>
                <button @click="${mint}" aria-disabled="${() => (s.mintBusy ? 'true' : 'false')}" class="${() => `rounded-control px-3.5 py-2 font-mono text-xs font-semibold text-[#12233f] transition ${s.mintBusy ? 'bg-brand/40' : 'bg-brand hover:bg-brand-hover'}`}">${() => (s.mintBusy ? 'minting…' : 'mint token')}</button>
              </div>`
            : ''}

        ${() =>
          s.minted
            ? html`
              <div class="border-b border-line px-4 py-4" style="background:color-mix(in srgb, var(--color-ok) 10%, transparent)">
                <div class="font-mono text-[11px] uppercase tracking-wider" style="color:var(--color-ok)">Token minted — copy it now, it won't be shown again</div>
                <div class="mt-2 flex items-center gap-2">
                  <code class="flex-1 truncate rounded-control border border-line bg-surface-inset px-3 py-2 font-mono text-xs text-fg">${() => s.minted.token}</code>
                  <button @click="${copyToken}" class="rounded-control border border-line px-3 py-2 font-mono text-[11px] text-fg-soft hover:bg-surface-inset">copy</button>
                  <button @click="${() => { s.minted = null }}" class="rounded-control border border-line px-3 py-2 font-mono text-[11px] text-fg-faint hover:bg-surface-inset">dismiss</button>
                </div>
              </div>`
            : ''}

        <div class="grid grid-cols-[1.4fr_2fr_0.8fr_0.6fr] border-b border-line font-mono text-[11px] uppercase tracking-wider text-fg-faint">
          <div class="px-4 py-2.5 font-medium">Name</div>
          <div class="px-4 py-2.5 font-medium">Scopes</div>
          <div class="px-4 py-2.5 font-medium">Expires</div>
          <div class="px-4 py-2.5 font-medium"></div>
        </div>
        ${() => {
          if (s.tokens === null) return html`<div class="px-4 py-6 text-center text-fg-faint">Loading…</div>`
          if (!s.tokens.length) return html`<div class="px-4 py-6 text-center text-fg-faint">No API tokens yet.</div>`
          return html`<div>${s.tokens.map((t) => html`
            <div class="grid grid-cols-[1.4fr_2fr_0.8fr_0.6fr] items-center border-b border-line/60">
              <div class="px-4 py-2.5 font-medium text-fg">${t.name || '(unnamed)'}</div>
              <div class="px-4 py-2.5">
                <span class="flex flex-wrap gap-1">
                  ${(t.scopes ?? []).map((/** @type {string} */ sc) => html`<span class="rounded border border-line px-1.5 py-0.5 font-mono text-[10px] text-fg-soft">${sc}</span>`)}
                </span>
              </div>
              <div class="px-4 py-2.5 font-mono text-xs text-fg-faint">${fmtExpiry(t.expires_at)}</div>
              <div class="px-4 py-2.5 text-right">
                <button
                  @click="${() => revokeToken(t.id, t.name || 'unnamed')}"
                  aria-disabled="${() => (s.busy === t.id ? 'true' : 'false')}"
                  class="${() => `rounded-control border border-line px-2 py-1 font-mono text-[11px] text-fg-soft transition ${s.busy === t.id ? 'opacity-50' : 'hover:border-bad hover:text-bad'}`}"
                >revoke</button>
              </div>
            </div>`.key(t.id))}</div>`
        }}
      </section>

      <section class="rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
        <div class="mb-3">${eyebrow('Auth collections')}</div>
        ${() => {
          if (s.authCols === null) return html`<p class="text-sm text-fg-faint">Loading…</p>`
          if (!s.authCols.length) return html`<p class="text-sm text-fg-faint">No auth collections yet — create one in Data to manage users.</p>`
          return html`<div class="grid gap-2 sm:grid-cols-2">${s.authCols.map((c) => html`
            <div class="flex items-center justify-between rounded-control border border-line bg-surface-inset px-3 py-2.5">
              <span class="font-medium text-fg">${c.name}</span>
              ${Link({ to: `/collections/${c.id}`, children: 'schema →', class: 'font-mono text-[11px] text-fg-faint hover:text-brand' })}
            </div>`.key(c.id))}</div>`
        }}
      </section>
    </div>
  `
}

export default AccessPage
