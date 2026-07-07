import { createStore } from '../framework/index.js'
import { api, setToken } from '../lib/api.js'

/** @typedef {{ id: string, email: string, role?: string, exp?: number }} Admin */

export const authState = createStore((reactive) => {
  const s = reactive(/** @type {{ admin: Admin | null, loaded: boolean, setupDone: boolean }} */ ({ admin: null, loaded: false, setupDone: true }))

  async function load() {
    const res = /** @type {import('../lib/api.js').ApiResponse<Admin>} */ (
      await api.get('/api/v1/admin/auth/me')
    )
    s.admin = res?.data?.id ? res.data : null
    s.loaded = true
  }

  /** Is the first admin set up yet? Public endpoint — safe to call before login. */
  async function checkSetup() {
    const res = /** @type {import('../lib/api.js').ApiResponse<{ has_admin: boolean }>} */ (
      await api.get('/api/v1/admin/setup/status')
    )
    s.setupDone = !!res?.data?.has_admin
  }

  /** @param {string} email @param {string} password */
  async function signIn(email, password) {
    const res = /** @type {import('../lib/api.js').ApiResponse<{ token: string }>} */ (
      await api.post('/api/v1/admin/auth/login', { email, password })
    )
    if (res?.error) throw new Error(res.error)
    if (res?.data?.token) setToken(res.data.token)
    await load()
  }

  return {
    get admin() { return s.admin },
    get loggedIn() { return !!s.admin },
    get loaded() { return s.loaded },
    get setupDone() { return s.setupDone },
    load,
    checkSetup,
    signIn,
    /** Create the first (owner) admin, then sign straight in. @param {string} email @param {string} password */
    async setup(email, password) {
      const res = /** @type {import('../lib/api.js').ApiResponse<{ id: string }>} */ (
        await api.post('/api/v1/admin/setup', { email, password })
      )
      if (res?.error) throw new Error(res.error)
      s.setupDone = true
      await signIn(email, password)
    },
    async signOut() {
      try { await api.post('/api/v1/auth/logout', {}) } catch { /* best-effort */ }
      setToken(null)
      s.admin = null
    },
  }
})
