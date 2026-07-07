import './style.css'
import { createApp, provide } from './framework/index.js'
import { beforeEach, initRouter } from './framework/router.js'
import { authState } from './state/authState.js'

provide('app', { name: 'Cogworks', tagline: 'the works, without the work' })

// Resolve first-run + session state before the first navigation.
// Check setup first: on a brand-new server there's no admin, so we skip the
// /auth/me call (which would 401) and route straight to the setup wizard.
try {
  await authState.checkSetup()
  if (authState.setupDone) await authState.load()
} catch {
  // Server unreachable — treat as logged out; the guard sends us to /login.
}

beforeEach(({ to }) => {
  // No admin yet → the setup wizard is the only reachable page.
  if (!authState.setupDone) return to === '/setup' ? undefined : '/setup'
  if (to === '/setup') return authState.loggedIn ? '/' : '/login'
  if (to === '/login') return authState.loggedIn ? '/' : undefined
  if (!authState.loggedIn) return '/login'
})

await initRouter()
await createApp({ root: '#app' })
