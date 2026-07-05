import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useToast } from '../composables/useToast.js'
import { api } from '../lib/api.js'
import { SettingsPanels } from '../components/SettingsPanels.js'

export const meta = { layout: 'menu', title: 'Settings' }

const mailTest = { label: 'Send test', run: async () => {
  const to = globalThis.prompt('Send a test email to:')
  if (!to) throw new Error('cancelled')
  const r = /** @type {any} */ (await api.post('/api/v1/admin/settings/smtp/test', { to }))
  if (r?.error) throw new Error(r.error)
} }
const storageTest = { label: 'Test storage', run: async () => {
  const r = /** @type {any} */ (await api.post('/api/v1/admin/settings/storage/test', {}))
  if (r?.error) throw new Error(r.error)
} }

/** @type {import('../components/SettingsPanels.js').Panel[]} */
const PANELS = [
  { title: 'Application', fields: [
    { key: 'app.url', label: 'App URL', placeholder: 'https://api.example.com', help: 'Used in emails and OAuth callbacks.' },
    { key: 'docs.enabled', label: 'Serve OpenAPI docs', type: 'bool' },
  ] },
  { title: 'Mail', help: 'Outbound email for verification, resets, and OTP.', test: mailTest, fields: [
    { key: 'mail.transport', label: 'Transport', type: 'select', options: ['smtp', 'http', 'none'] },
    { key: 'mail.http.api_key', label: 'HTTP provider API key', type: 'password' },
  ] },
  { title: 'Rate limiting & queues', fields: [
    { key: 'rate_limit.enabled', label: 'Enable rate limiting', type: 'bool' },
    { key: 'queues.visibility_timeout_sec', label: 'Queue visibility timeout (s)', type: 'number' },
  ] },
  { title: 'CORS & hook egress', fields: [
    { key: 'cors.origins', label: 'Allowed origins', placeholder: 'https://app.example.com, https://admin.example.com', help: 'Comma-separated. Empty = same-origin only.' },
    { key: 'hooks.http.allow', label: 'Hook HTTP allowlist', placeholder: 'api.stripe.com, *.internal' },
    { key: 'hooks.http.deny', label: 'Hook HTTP denylist' },
  ] },
  { title: 'Telemetry', fields: [
    { key: 'metrics.enabled', label: 'Prometheus metrics', type: 'bool' },
    { key: 'metrics.token', label: 'Metrics token', type: 'password' },
    { key: 'otel.endpoint', label: 'OTel endpoint' },
    { key: 'otel.service_name', label: 'OTel service name', placeholder: 'cogworks' },
  ] },
  { title: 'Execution limits', fields: [
    { key: 'execution.timeout_ms', label: 'Hook/route timeout (ms)', type: 'number' },
    { key: 'hooks.slow_ms', label: 'Slow-hook warning (ms)', type: 'number' },
  ] },
  { title: 'Storage', help: 'Where uploaded files live.', test: storageTest, fields: [
    { key: 's3.bucket', label: 'S3 / R2 bucket', placeholder: 'leave empty for local disk' },
  ] },
]

function SettingsPage() {
  useMeta({ title: 'Settings · Cogworks' })
  const toast = useToast()

  const s = reactive(/** @type {{ storage:any, latest:string, advOpen:boolean, busy:boolean }} */ ({ storage: null, latest: 'v0.1.0', advOpen: false, busy: false }))
  api.get('/api/v1/admin/settings/storage/status').then((r) => { s.storage = /** @type {any} */ (r)?.data ?? {} }).catch(() => { s.storage = {} })
  api.get('/api/v1/admin/settings').then((r) => { s.latest = /** @type {any} */ (r)?.data?.['update_check.latest_version'] || 'v0.1.0' }).catch(() => {})
  let advKey = ''; let advVal = ''
  async function setRaw() {
    if (!advKey.trim()) { toast.error('Key required'); return }
    s.busy = true
    try { const r = /** @type {any} */ (await api.patch('/api/v1/admin/settings', { [advKey.trim()]: advVal })); if (r?.error) throw new Error(r.error); toast.success('Saved') } catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') } finally { s.busy = false }
  }

  const stat = (/** @type {string} */ label, /** @type {()=>any} */ val, /** @type {string} */ tone = '') => html`
    <div class="card p-4"><div class="field-label">${label}</div><div class="mt-1 font-display text-xl font-semibold" style="${`color:${tone || 'var(--color-fg)'}`}">${val}</div></div>`

  return html`
    <div class="space-y-5">
      <div>
        <h1 class="font-display text-2xl font-semibold text-fg">Settings</h1>
        <p class="mt-0.5 text-sm text-fg-soft">Configure your Cogworks server.</p>
      </div>

      <div class="grid gap-4 sm:grid-cols-3">
        ${stat('Latest release', () => s.latest, 'var(--color-brand)')}
        ${stat('Storage', () => (s.storage === null ? '…' : (s.storage.driver ?? 'local')))}
        ${stat('Server', () => 'operational', 'var(--color-ok)')}
      </div>

      ${SettingsPanels({ panels: PANELS })}

      <div class="card">
        <button class="card-head w-full cursor-pointer text-left" @click="${() => { s.advOpen = !s.advOpen }}">
          <span class="card-title">Advanced — raw key/value</span>
          <span class="text-xs text-fg-faint">${() => (s.advOpen ? 'hide' : 'show')}</span>
        </button>
        ${() => s.advOpen ? html`
          <div class="card-pad space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <input class="input flex-1" placeholder="setting.key" @input="${(/** @type {any} */ e) => { advKey = e.target.value }}" />
              <input class="input flex-1" placeholder="value" @input="${(/** @type {any} */ e) => { advVal = e.target.value }}" />
              <button class="btn btn-secondary" aria-disabled="${() => (s.busy ? 'true' : 'false')}" @click="${setRaw}">Set</button>
            </div>
            <p class="text-xs text-fg-faint">Writes any key directly via <span class="mono">PATCH /admin/settings</span>. For keys not covered above.</p>
          </div>` : ''}
      </div>
    </div>
  `
}

export default SettingsPage
