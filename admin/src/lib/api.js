/**
 * Cogworks admin API client. Ported from the old React admin (framework-neutral
 * fetch wrapper): bearer token in sessionStorage + a same-origin HttpOnly cookie,
 * with a 401 bounce to /_/login. Plain JS + JSDoc per Quiver conventions.
 */

const BASE = ''
const TOKEN_STORAGE_KEY = 'cogworks_admin_token'
const PUBLIC_PATHS = ['/api/v1/admin/setup', '/api/v1/admin/auth/login', '/api/v1/auth/refresh']

/** @param {string | null} token */
export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token)
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY)
  } catch { /* private mode / quota — ignore */ }
}

/** @returns {string | null} */
export function getToken() {
  try { return sessionStorage.getItem(TOKEN_STORAGE_KEY) }
  catch { return null }
}

/**
 * @template T
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @returns {Promise<T>}
 */
async function req(method, path, body) {
  /** @type {Record<string,string>} */
  const headers = { 'Content-Type': 'application/json' }
  const token = getToken()
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, {
    method,
    credentials: 'same-origin',
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (res.status === 401 && !PUBLIC_PATHS.some((p) => path.startsWith(p))) {
    setToken(null)
    const p = window.location.pathname
    if (!p.startsWith('/_/login') && !p.startsWith('/_/setup')) window.location.href = '/_/login'
  }
  return /** @type {Promise<T>} */ (res.json())
}

/**
 * Download an authenticated endpoint as a file (blob), bypassing JSON parsing.
 * @param {string} path @param {string} filename
 */
export async function apiDownload(path, filename) {
  const token = getToken()
  const res = await fetch(BASE + path, {
    credentials: 'same-origin',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) {
    let msg = `Download failed (${res.status})`
    try { msg = (await res.json())?.error || msg } catch { /* not json */ }
    throw new Error(msg)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url; a.download = filename; document.body.appendChild(a); a.click()
  a.remove(); URL.revokeObjectURL(url)
}

/**
 * POST a raw (non-JSON) text body and return the parsed JSON response.
 * @template T @param {string} path @param {string} text @param {string} [contentType]
 * @returns {Promise<T>}
 */
export async function apiPostText(path, text, contentType = 'text/csv') {
  const token = getToken()
  /** @type {Record<string,string>} */ const headers = { 'Content-Type': contentType }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(BASE + path, { method: 'POST', credentials: 'same-origin', headers, body: text })
  return /** @type {Promise<T>} */ (res.json())
}

export const api = {
  /** @template T @param {string} path @returns {Promise<T>} */
  get: (path) => req('GET', path),
  /** @template T @param {string} path @param {unknown} body @returns {Promise<T>} */
  post: (path, body) => req('POST', path, body),
  /** @template T @param {string} path @param {unknown} body @returns {Promise<T>} */
  patch: (path, body) => req('PATCH', path, body),
  /** @template T @param {string} path @returns {Promise<T>} */
  delete: (path) => req('DELETE', path),
}

/**
 * @template T
 * @typedef {{ data?: T, error?: string, code?: number, details?: Record<string,string> }} ApiResponse
 */

/**
 * @typedef {Object} FieldDef
 * @property {string} name
 * @property {string} type
 * @property {boolean} [required]
 * @property {boolean} [system]
 * @property {boolean} [implicit]
 * @property {string} [collection]
 * @property {Record<string,unknown>} [options]
 */

/**
 * @typedef {Object} Collection
 * @property {string} id
 * @property {string} name
 * @property {'base'|'auth'|'view'} type
 * @property {string} fields
 * @property {string|null} view_query
 * @property {string|null} list_rule
 * @property {string|null} view_rule
 * @property {string|null} create_rule
 * @property {string|null} update_rule
 * @property {string|null} delete_rule
 * @property {number} created_at
 * @property {number} updated_at
 */

/** @param {string} raw @returns {FieldDef[]} */
export function parseFields(raw) {
  try { return JSON.parse(raw) } catch { return [] }
}
