import './style.css'
import { createApp, provide } from './framework/index.js'
import { beforeEach, initRouter } from './framework/router.js'
import { authState } from './state/authState.js'

provide('app', { name: 'Cogworks', tagline: 'the works, without the work' })

// Resolve the session once so the first navigation already knows if we're authed.
try {
  await authState.load()
} catch {
  // Server unreachable — treat as logged out; the guard sends us to /login.
}

beforeEach(({ to }) => {
  if (to === '/login') return authState.loggedIn ? '/' : undefined
  if (!authState.loggedIn) return '/login'
})

await initRouter()
await createApp({ root: '#app' })
