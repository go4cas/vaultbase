import { html, reactive } from '@arrow-js/core'
import { useToast } from '../composables/useToast.js'
import { api } from '../lib/api.js'
import { Icon } from './Icon.js'

/**
 * @typedef {{ key:string, label:string, type?:'text'|'number'|'bool'|'password'|'textarea'|'select', help?:string, placeholder?:string, options?:string[], default?:any }} Field
 * @typedef {{ title:string, help?:string, fields:Field[], test?:{ label:string, run:()=>Promise<any> } }} Panel
 */

/**
 * Renders grouped, saveable settings panels backed by /admin/settings.
 * @param {{ panels: Panel[] }} props
 */
export function SettingsPanels({ panels }) {
  const toast = useToast()
  const s = reactive(/** @type {{ loaded:boolean, saving:string }} */ ({ loaded: false, saving: '' }))
  /** @type {Record<string,any>} */ let vals = {}
  /** @type {Record<string,boolean>} */ let touchedSecret = {}

  const load = () => api.get('/api/v1/admin/settings').then((r) => {
    const cur = /** @type {any} */ (r)?.data ?? {}
    vals = {}
    for (const p of panels) for (const f of p.fields) {
      const raw = cur[f.key]
      vals[f.key] = f.type === 'bool' ? (raw === true || raw === 'true') : (raw ?? f.default ?? '')
    }
    s.loaded = true
  }).catch(() => { s.loaded = true })
  load()

  async function savePanel(/** @type {Panel} */ p) {
    if (s.saving) return
    s.saving = p.title
    try {
      /** @type {Record<string,any>} */ const body = {}
      for (const f of p.fields) {
        if (f.type === 'password' && !touchedSecret[f.key]) continue // don't overwrite secrets with blanks
        body[f.key] = f.type === 'number' ? Number(vals[f.key]) : vals[f.key]
      }
      const r = /** @type {any} */ (await api.patch('/api/v1/admin/settings', body))
      if (r?.error) throw new Error(r.error)
      toast.success(`${p.title} saved`)
      await load()
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Save failed') } finally { s.saving = '' }
  }

  function field(/** @type {Field} */ f) {
    const t = f.type ?? 'text'
    const set = (/** @type {any} */ v) => { vals[f.key] = v; if (t === 'password') touchedSecret[f.key] = true }
    let control
    if (t === 'bool') {
      control = vals[f.key]
        ? html`<input type="checkbox" checked @change="${(/** @type {any} */ e) => set(e.target.checked)}" />`
        : html`<input type="checkbox" @change="${(/** @type {any} */ e) => set(e.target.checked)}" />`
      return html`<label class="flex items-center gap-2.5 py-1"><span>${control}</span><span class="text-sm text-fg">${f.label}</span>${f.help ? html`<span class="text-xs text-fg-faint">${f.help}</span>` : ''}</label>`
    }
    if (t === 'select') {
      const cur = vals[f.key] ?? (f.options?.[0] ?? '')
      const opts = [cur, ...(f.options ?? []).filter((o) => o !== cur)]
      control = html`<select class="select" @change="${(/** @type {any} */ e) => set(e.target.value)}">${opts.map((o) => html`<option value="${o}">${o}</option>`.key(o))}</select>`
    } else if (t === 'textarea') {
      control = html`<textarea class="textarea mono" style="min-height:5rem;font-size:0.8rem" @input="${(/** @type {any} */ e) => set(e.target.value)}">${vals[f.key] ?? ''}</textarea>`
    } else {
      control = html`<input class="input" type="${t === 'password' ? 'password' : t === 'number' ? 'number' : 'text'}" placeholder="${f.placeholder ?? (t === 'password' ? '•••••• (unchanged)' : '')}" value="${vals[f.key] ?? ''}" @input="${(/** @type {any} */ e) => set(e.target.value)}" />`
    }
    return html`<label class="space-y-1 block"><span class="field-label">${f.label}</span>${control}${f.help ? html`<span class="block text-xs text-fg-faint">${f.help}</span>` : ''}</label>`
  }

  return html`
    ${() => !s.loaded ? html`<div class="card p-8 text-center text-sm text-fg-faint">Loading settings…</div>` : html`
      <div class="space-y-4">
        ${panels.map((p) => html`
          <div class="card card-pad space-y-4">
            <div class="flex items-center justify-between">
              <div><div class="card-title">${p.title}</div>${p.help ? html`<div class="mt-0.5 text-xs text-fg-faint">${p.help}</div>` : ''}</div>
              <div class="flex items-center gap-2">
                ${p.test ? html`<button class="btn btn-secondary btn-sm" @click="${async () => { try { await p.test?.run(); toast.success('Test ok') } catch (/** @type {any} */ e) { toast.error(e?.message || 'Test failed') } }}">${p.test.label}</button>` : ''}
                <button class="btn btn-primary btn-sm" aria-disabled="${() => (s.saving === p.title ? 'true' : 'false')}" @click="${() => savePanel(p)}">${() => (s.saving === p.title ? 'Saving…' : 'Save')}</button>
              </div>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              ${p.fields.map((f) => html`<div class="${f.type === 'textarea' ? 'sm:col-span-2' : ''}">${field(f)}</div>`.key(f.key))}
            </div>
          </div>`.key(p.title))}
      </div>`}
  `
}
