import { createStore } from '../framework/index.js'
import { api, setToken } from '../lib/api.js'

/** @typedef {{ id: string, email: string, role?: string, exp?: number }} Admin */

export const authState = createStore((reactive) => {
  const s = reactive(/** @type {{ admin: Admin | null, loaded: boolean }} */ ({ admin: null, loaded: false }))

  async function load() {
    const res = /** @type {import('../lib/api.js').ApiResponse<Admin>} */ (
      await api.get('/api/v1/admin/auth/me')
    )
    s.admin = res?.data?.id ? res.data : null
    s.loaded = true
  }

  return {
    get admin() { return s.admin },
    get loggedIn() { return !!s.admin },
    get loaded() { return s.loaded },
    load,
    /** @param {string} email @param {string} password */
    async signIn(email, password) {
      const res = /** @type {import('../lib/api.js').ApiResponse<{ token: string }>} */ (
        await api.post('/api/v1/admin/auth/login', { email, password })
      )
      if (res?.error) throw new Error(res.error)
      if (res?.data?.token) setToken(res.data.token)
      await load()
    },
    async signOut() {
      try { await api.post('/api/v1/auth/logout', {}) } catch { /* best-effort */ }
      setToken(null)
      s.admin = null
    },
  }
})
