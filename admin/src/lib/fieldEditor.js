import { html } from '@arrow-js/core'

// Shared collection field-editor vocabulary + controls, used by both the
// create-collection form and the collection Fields tab so they stay in sync.

export const FIELD_TYPES = ['text', 'editor', 'number', 'bool', 'email', 'url', 'date', 'autodate', 'json', 'select', 'relation', 'file', 'geoPoint', 'vector']

/** Which extra options apply to each type — mirrors what the server honors
 * (src/core/validate.ts). `collection` is top-level; the rest nest under `options`.
 * @type {Record<string, string[]>} */
export const TYPE_OPTS = {
  text: ['unique', 'encrypted', 'searchable', 'min', 'max', 'pattern'],
  editor: ['searchable', 'max'],
  number: ['unique', 'min', 'max'],
  email: ['unique', 'searchable'],
  url: ['unique', 'searchable'],
  date: ['unique'],
  json: ['encrypted'],
  select: ['values', 'multiple', 'unique'],
  relation: ['collection', 'cascade', 'unique'],
  file: ['maxSize', 'mimeTypes', 'multiple'],
  vector: ['dimensions'],
}
/** Option keys coerced to numbers on save. `collection` is stored top-level. */
export const NUM_OPTS = ['min', 'max', 'maxSize', 'dimensions']
/** Option keys that are comma-lists coerced to string[] on save. */
export const LIST_OPTS = ['values', 'mimeTypes']
export const CASCADE_OPTS = ['setNull', 'cascade', 'restrict']

/** Build a clean field def from a draft: name/type/required/collection top-level, the rest under `options`. */
export function fieldOut(/** @type {any} */ f) {
  /** @type {any} */ const out = { name: f.name.trim(), type: f.type }
  if (f.required) out.required = true
  /** @type {any} */ const options = {}
  for (const k of TYPE_OPTS[f.type] ?? []) {
    if (k === 'collection') { if (f.collection?.trim()) out.collection = f.collection.trim(); continue }
    const v = f[k]
    if (v === undefined || v === '' || v === false) continue
    if (LIST_OPTS.includes(k)) options[k] = String(v).split(',').map((x) => x.trim()).filter(Boolean)
    else if (NUM_OPTS.includes(k)) options[k] = Number(v)
    else options[k] = v
  }
  if (Object.keys(options).length) out.options = options
  return out
}

function optCheck(/** @type {any} */ draft, /** @type {number} */ rid, /** @type {string} */ key, /** @type {string} */ label) {
  return draft[rid]?.[key]
    ? html`<label class="flex items-center gap-1.5 text-xs text-fg-soft"><input type="checkbox" checked @change="${(/** @type {any} */ e) => { draft[rid][key] = e.target.checked }}" />${label}</label>`
    : html`<label class="flex items-center gap-1.5 text-xs text-fg-soft"><input type="checkbox" @change="${(/** @type {any} */ e) => { draft[rid][key] = e.target.checked }}" />${label}</label>`
}
function optNum(/** @type {any} */ draft, /** @type {number} */ rid, /** @type {string} */ key, /** @type {string} */ ph) {
  return html`<input class="input" style="width:6rem" type="number" placeholder="${ph}" value="${draft[rid]?.[key] ?? ''}" @input="${(/** @type {any} */ e) => { draft[rid][key] = e.target.value }}" />`
}
function optText(/** @type {any} */ draft, /** @type {number} */ rid, /** @type {string} */ key, /** @type {string} */ ph) {
  return html`<input class="input flex-1" placeholder="${ph}" value="${draft[rid]?.[key] ?? ''}" @input="${(/** @type {any} */ e) => { draft[rid][key] = e.target.value }}" />`
}

/**
 * Per-type option controls for one field-draft row. The relation target renders
 * as a dropdown when `collections` (names) are supplied, else a text input.
 * @param {any} draft the fieldDraft map @param {number} rid @param {string[]} [collections]
 */
export function fieldOptionControls(draft, rid, collections = []) {
  const t = draft[rid]?.type ?? 'text'
  const opts = TYPE_OPTS[t] ?? []
  if (!opts.length) return html`<span class="text-xs text-fg-faint">No extra options for ${t}.</span>`
  const cur = draft[rid]?.collection || ''
  const relControl = collections.length
    ? html`<select class="select" style="width:11rem" @change="${(/** @type {any} */ e) => { draft[rid].collection = e.target.value }}">${['', ...collections].filter((c, i, a) => a.indexOf(c) === i).sort((a) => (a === cur ? -1 : 0)).map((c) => html`<option value="${c}">${c || 'select a collection…'}</option>`.key(c || '__none'))}</select>`
    : optText(draft, rid, 'collection', 'posts')
  return html`<div class="flex flex-wrap items-center gap-3">
    ${opts.includes('unique') ? optCheck(draft, rid, 'unique', 'unique') : ''}
    ${opts.includes('encrypted') ? optCheck(draft, rid, 'encrypted', 'encrypted') : ''}
    ${opts.includes('searchable') ? optCheck(draft, rid, 'searchable', 'full-text') : ''}
    ${opts.includes('multiple') ? optCheck(draft, rid, 'multiple', 'multiple') : ''}
    ${opts.includes('min') ? html`<label class="flex items-center gap-1 text-xs text-fg-soft">min ${optNum(draft, rid, 'min', '')}</label>` : ''}
    ${opts.includes('max') ? html`<label class="flex items-center gap-1 text-xs text-fg-soft">max ${optNum(draft, rid, 'max', '')}</label>` : ''}
    ${opts.includes('pattern') ? html`<label class="flex flex-1 items-center gap-1 text-xs text-fg-soft">regex ${optText(draft, rid, 'pattern', '^[a-z]+$')}</label>` : ''}
    ${opts.includes('values') ? html`<label class="flex flex-1 items-center gap-1 text-xs text-fg-soft">values ${optText(draft, rid, 'values', 'draft, published, archived')}</label>` : ''}
    ${opts.includes('collection') ? html`<label class="flex items-center gap-1 text-xs text-fg-soft">target ${relControl}</label>` : ''}
    ${opts.includes('cascade') ? html`<label class="flex items-center gap-1 text-xs text-fg-soft">on delete <select class="select" style="width:8rem" @change="${(/** @type {any} */ e) => { draft[rid].cascade = e.target.value }}">${[draft[rid]?.cascade || 'setNull', ...CASCADE_OPTS.filter((x) => x !== (draft[rid]?.cascade || 'setNull'))].map((x) => html`<option value="${x}">${x}</option>`.key(x))}</select></label>` : ''}
    ${opts.includes('mimeTypes') ? html`<label class="flex flex-1 items-center gap-1 text-xs text-fg-soft">mime types ${optText(draft, rid, 'mimeTypes', 'image/png, image/jpeg')}</label>` : ''}
    ${opts.includes('maxSize') ? html`<label class="flex items-center gap-1 text-xs text-fg-soft">maxSize (B) ${optNum(draft, rid, 'maxSize', '5242880')}</label>` : ''}
    ${opts.includes('dimensions') ? html`<label class="flex items-center gap-1 text-xs text-fg-soft">dimensions ${optNum(draft, rid, 'dimensions', '1536')}</label>` : ''}
  </div>`
}
