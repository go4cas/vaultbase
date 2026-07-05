import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useRouter } from '../composables/useRouter.js'
import { useToast } from '../composables/useToast.js'
import { api } from '../lib/api.js'
import { Icon } from '../components/Icon.js'
import { SettingsPanels } from '../components/SettingsPanels.js'

export const meta = { layout: 'menu', title: 'Auth' }

/** @type {Record<string, string>} */
const ROLE_COLOR = { owner: 'var(--color-brand)', admin: 'var(--color-ok)', editor: 'var(--color-warn)', viewer: 'var(--color-fg-faint)' }
const SCOPES = ['read', 'write', 'admin', 'mcp:read', 'mcp:write', 'mcp:admin', 'mcp:sql']
const fmtDate = (/** @type {number} */ ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : '—')
const fmtExpiry = (/** @type {number} */ ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : 'never')

/** @type {import('../components/SettingsPanels.js').Panel[]} */
const AUTH_PANELS = [
  { title: 'Auth methods', help: 'Which sign-in methods your users can use.', fields: [
    { key: 'auth.mfa.enabled', label: 'MFA / TOTP', type: 'bool' },
    { key: 'auth.webauthn.enabled', label: 'Passkeys (WebAuthn)', type: 'bool' },
    { key: 'auth.otp.enabled', label: 'OTP / magic-link', type: 'bool' },
    { key: 'auth.anonymous.enabled', label: 'Anonymous sessions', type: 'bool' },
    { key: 'auth.impersonation.enabled', label: 'Admin impersonation', type: 'bool' },
  ] },
  { title: 'Password policy', fields: [
    { key: 'password.min_length', label: 'Minimum length', type: 'number' },
    { key: 'password.require_upper', label: 'Require uppercase', type: 'bool' },
    { key: 'password.require_lower', label: 'Require lowercase', type: 'bool' },
    { key: 'password.require_digit', label: 'Require digit', type: 'bool' },
    { key: 'password.require_symbol', label: 'Require symbol', type: 'bool' },
    { key: 'password.hibp_check', label: 'Block breached passwords (HIBP)', type: 'bool' },
  ] },
  { title: 'Lockout & sessions', fields: [
    { key: 'auth.lockout.max_attempts', label: 'Max failed attempts', type: 'number' },
    { key: 'auth.lockout.duration_seconds', label: 'Lockout duration (s)', type: 'number' },
    { key: 'auth.user.window_seconds', label: 'User session window (s)', type: 'number' },
    { key: 'auth.admin.window_seconds', label: 'Admin session window (s)', type: 'number' },
  ] },
  { title: 'Google OAuth', fields: [
    { key: 'oauth2.google.enabled', label: 'Enabled', type: 'bool' },
    { key: 'oauth2.google.client_id', label: 'Client ID' },
    { key: 'oauth2.google.client_secret', label: 'Client secret', type: 'password' },
  ] },
  { title: 'GitHub OAuth', fields: [
    { key: 'oauth2.github.enabled', label: 'Enabled', type: 'bool' },
    { key: 'oauth2.github.client_id', label: 'Client ID' },
    { key: 'oauth2.github.client_secret', label: 'Client secret', type: 'password' },
  ] },
  { title: 'Apple OAuth', fields: [
    { key: 'oauth2.apple.enabled', label: 'Enabled', type: 'bool' },
    { key: 'oauth2.apple.client_id', label: 'Client ID (services ID)' },
    { key: 'oauth2.apple.team_id', label: 'Team ID' },
    { key: 'oauth2.apple.key_id', label: 'Key ID' },
    { key: 'oauth2.apple.private_key', label: 'Private key (.p8)', type: 'textarea' },
  ] },
  { title: 'OIDC (generic)', fields: [
    { key: 'oauth2.oidc.enabled', label: 'Enabled', type: 'bool' },
    { key: 'oauth2.oidc.display_name', label: 'Display name' },
    { key: 'oauth2.oidc.client_id', label: 'Client ID' },
    { key: 'oauth2.oidc.client_secret', label: 'Client secret', type: 'password' },
    { key: 'oauth2.oidc.authorization_url', label: 'Authorization URL' },
    { key: 'oauth2.oidc.token_url', label: 'Token URL' },
    { key: 'oauth2.oidc.userinfo_url', label: 'Userinfo URL' },
    { key: 'oauth2.oidc.scopes', label: 'Scopes', placeholder: 'openid profile email' },
  ] },
]

function AuthPage() {
  useMeta({ title: 'Auth · Cogworks' })
  const router = useRouter()
  const toast = useToast()

  const s = reactive(
    /** @type {{ tab:string, admins:any[]|null, tokens:any[]|null, authCols:any[]|null, busy:string, minting:boolean, mintName:string, mintScopes:string[], mintBusy:boolean, minted:any }} */
    ({ tab: 'access', admins: null, tokens: null, authCols: null, busy: '', minting: false, mintName: '', mintScopes: ['read'], mintBusy: false, minted: null }),
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
  const toggleScope = (/** @type {string} */ sc) => { s.mintScopes = s.mintScopes.includes(sc) ? s.mintScopes.filter((x) => x !== sc) : [...s.mintScopes, sc] }
  async function mint() {
    if (s.mintBusy) return
    if (!s.mintName.trim()) { toast.error('Name is required'); return }
    if (!s.mintScopes.length) { toast.error('Pick at least one scope'); return }
    s.mintBusy = true
    try {
      const r = /** @type {any} */ (await api.post('/api/v1/admin/api-tokens', { name: s.mintName.trim(), scopes: s.mintScopes }))
      if (r?.error) throw new Error(r.error)
      s.minted = r?.data ?? null; s.minting = false; s.mintName = ''; s.mintScopes = ['read']; await loadTokens(); toast.success('Token minted')
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Mint failed') } finally { s.mintBusy = false }
  }
  async function forceLogoutAll() {
    if (!globalThis.confirm('Sign out every user session across the server? Admins included.')) return
    try { const r = /** @type {any} */ (await api.post('/api/v1/admin/security/force-logout-all', {})); if (r?.error) throw new Error(r.error); toast.success('All sessions revoked') } catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') }
  }

  const tabBtn = (/** @type {string} */ t, /** @type {string} */ label) => html`
    <button @click="${() => { s.tab = t }}" class="${() => `border-b-2 px-1 pb-2.5 pt-1 text-sm font-medium transition-colors ${s.tab === t ? 'border-brand text-fg' : 'border-transparent text-fg-faint hover:text-fg-soft'}`}">${label}</button>`

  return html`
    <div class="space-y-5">
      <div>
        <h1 class="font-display text-2xl font-semibold text-fg">Auth</h1>
        <p class="mt-0.5 text-sm text-fg-soft">Operators, tokens, user collections, and how people sign in.</p>
      </div>
      <div class="flex gap-5 border-b border-line">${tabBtn('access', 'Access')}${tabBtn('config', 'Configuration')}</div>
      ${() => s.tab === 'access' ? accessTab() : configTab()}
    </div>
  `

  function configTab() {
    return html`
      <div class="space-y-4">
        ${SettingsPanels({ panels: AUTH_PANELS })}
        <div class="card card-pad">
          <div class="card-title" style="color:var(--color-bad)">Sessions</div>
          <div class="mt-3 flex items-center justify-between rounded-control border border-line px-4 py-3">
            <div><div class="text-sm font-medium text-fg">Force logout everyone</div><div class="text-xs text-fg-faint">Revoke all active user + admin sessions immediately.</div></div>
            <button class="btn btn-danger" @click="${forceLogoutAll}">${Icon({ name: 'logout', size: 14 })} Force logout all</button>
          </div>
        </div>
      </div>`
  }

  function accessTab() {
    return html`
      <div class="space-y-5">
        <div class="card overflow-hidden">
          <div class="card-head"><span class="card-title">Operators</span><span class="mono text-xs text-fg-faint">${() => (s.admins ? s.admins.length : '')}</span></div>
          <div class="grid thead" style="grid-template-columns:2fr 0.8fr 1fr"><div class="tcell py-2!">Email</div><div class="tcell py-2!">Role</div><div class="tcell py-2!">Added</div></div>
          ${() => {
            if (s.admins === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
            if (!s.admins.length) return html`<div class="p-8 text-center text-sm text-fg-faint">No operators.</div>`
            return html`<div>${s.admins.map((a) => html`
              <div class="grid trow" style="grid-template-columns:2fr 0.8fr 1fr">
                <div class="tcell text-sm text-fg">${a.email}</div>
                <div class="tcell"><span class="badge" style="${`color:${ROLE_COLOR[a.role] ?? 'var(--color-fg-soft)'}`}"><span class="dot" style="${`background:${ROLE_COLOR[a.role] ?? 'var(--color-fg-soft)'}`}"></span>${a.role}</span></div>
                <div class="tcell tcell-mono text-fg-faint">${fmtDate(a.created_at)}</div>
              </div>`.key(a.id ?? a.email))}</div>`
          }}
        </div>

        <div class="card overflow-hidden">
          <div class="card-head"><span class="card-title">API tokens</span><button class="btn btn-primary btn-sm" @click="${() => { s.minting = !s.minting; s.minted = null }}">${() => (s.minting ? 'Cancel' : html`${Icon({ name: 'plus', size: 13 })} New token`)}</button></div>
          ${() => s.minting ? html`
            <div class="space-y-3 border-b border-line bg-surface-inset px-4 py-4">
              <input class="input" placeholder="Token name (e.g. ci-deploy)" value="${() => s.mintName}" @input="${(/** @type {any} */ e) => { s.mintName = e.target.value }}" />
              <div class="flex flex-wrap gap-2">${SCOPES.map((sc) => html`<button @click="${() => toggleScope(sc)}" class="${() => `rounded-control border px-2.5 py-1 mono text-xs transition ${s.mintScopes.includes(sc) ? 'border-brand bg-brand-tint text-brand' : 'border-line text-fg-soft hover:bg-surface-hover'}`}">${sc}</button>`)}</div>
              <button class="btn btn-primary btn-sm" aria-disabled="${() => (s.mintBusy ? 'true' : 'false')}" @click="${mint}">${() => (s.mintBusy ? 'Minting…' : 'Mint token')}</button>
            </div>` : ''}
          ${() => s.minted ? html`
            <div class="border-b border-line px-4 py-4" style="background:color-mix(in srgb, var(--color-ok) 9%, transparent)">
              <div class="field-label" style="color:var(--color-ok)">Token minted — copy it now, it won't be shown again</div>
              <div class="mt-2 flex items-center gap-2">
                <code class="input mono flex-1 truncate text-xs">${() => s.minted.token}</code>
                <button class="btn btn-secondary btn-sm" @click="${() => { navigator.clipboard?.writeText(s.minted.token); toast.success('Copied') }}">${Icon({ name: 'copy', size: 13 })} Copy</button>
                <button class="btn btn-ghost btn-sm" @click="${() => { s.minted = null }}">Dismiss</button>
              </div>
            </div>` : ''}
          <div class="grid thead" style="grid-template-columns:1.4fr 2fr 0.8fr 0.6fr"><div class="tcell py-2!">Name</div><div class="tcell py-2!">Scopes</div><div class="tcell py-2!">Expires</div><div class="tcell py-2!"></div></div>
          ${() => {
            if (s.tokens === null) return html`<div class="p-8 text-center text-sm text-fg-faint">Loading…</div>`
            if (!s.tokens.length) return html`<div class="p-8 text-center text-sm text-fg-faint">No API tokens yet.</div>`
            return html`<div>${s.tokens.map((t) => html`
              <div class="grid trow items-center" style="grid-template-columns:1.4fr 2fr 0.8fr 0.6fr">
                <div class="tcell text-sm font-medium text-fg">${t.name || '(unnamed)'}</div>
                <div class="tcell"><span class="flex flex-wrap gap-1">${(t.scopes ?? []).map((/** @type {string} */ sc) => html`<span class="rounded border border-line px-1.5 py-0.5 mono text-[10px] text-fg-soft">${sc}</span>`)}</span></div>
                <div class="tcell tcell-mono text-fg-faint">${fmtExpiry(t.expires_at)}</div>
                <div class="tcell text-right"><button class="btn btn-danger btn-sm" aria-disabled="${() => (s.busy === t.id ? 'true' : 'false')}" @click="${() => revokeToken(t.id, t.name || 'unnamed')}">Revoke</button></div>
              </div>`.key(t.id))}</div>`
          }}
        </div>

        <div class="card card-pad">
          <div class="mb-3 card-title">Auth collections</div>
          ${() => {
            if (s.authCols === null) return html`<p class="text-sm text-fg-faint">Loading…</p>`
            if (!s.authCols.length) return html`<p class="text-sm text-fg-faint">No auth collections yet — create one in <button class="text-brand hover:underline" @click="${() => router.go('/collections')}">Data</button> to manage users.</p>`
            return html`<div class="grid gap-2 sm:grid-cols-2">${s.authCols.map((c) => html`
              <button class="flex items-center justify-between rounded-control border border-line bg-surface-inset px-3 py-2.5 text-left hover:bg-surface-hover" @click="${() => router.go(`/collections/${c.id}`)}">
                <span class="flex items-center gap-2 font-medium text-fg">${Icon({ name: 'auth', size: 15, class: 'text-fg-faint' })} ${c.name}</span>
                ${Icon({ name: 'chevronRight', size: 14, class: 'text-fg-faint' })}
              </button>`.key(c.id))}</div>`
          }}
        </div>
      </div>`
  }
}

export default AuthPage
