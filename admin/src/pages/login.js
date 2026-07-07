import { html } from '@arrow-js/core'
import { useForm } from '../composables/useForm.js'
import { useRouter } from '../composables/useRouter.js'
import { useMeta } from '../framework/index.js'
import { authState } from '../state/authState.js'
import { GearMark } from '../components/GearMark.js'

export const meta = { layout: 'basic', title: 'Sign in · Cogworks' }

function LoginPage() {
  useMeta({ title: 'Sign in · Cogworks' })
  const router = useRouter()

  const { form, handleSubmit, field } = useForm(
    { email: '', password: '' },
    {
      validate: (v) => {
        const errors = /** @type {Record<string,string>} */ ({})
        if (!v.email.trim()) errors.email = 'Email is required.'
        if (!v.password.trim()) errors.password = 'Password is required.'
        return errors
      },
      onSubmit: async (values) => {
        await authState.signIn(values.email.trim(), values.password)
        router.go('/')
      },
    },
  )

  const emailField = field('email')
  const passwordField = field('password')
  const inputCls =
    'mt-1.5 w-full rounded-control border border-line bg-surface-inset px-3 py-2.5 text-sm text-fg outline-none placeholder:text-fg-faint transition focus:border-brand focus:bg-surface-raised'

  return html`
    <div>
      <div class="flex items-center gap-3">
        ${GearMark({ size: 40 })}
        <div class="flex flex-col leading-tight">
          <span class="font-display text-2xl font-semibold text-brand">Cogworks</span>
          <span class="mt-0.5 font-mono text-xs text-fg-faint">the works, without the work</span>
        </div>
      </div>

      <div class="mt-6">
        <h1 class="font-display text-2xl font-semibold text-fg">Sign in</h1>
        <p class="mt-1 text-sm text-fg-soft">Admin console for your Cogworks server.</p>
      </div>

      <form class="mt-6 space-y-4" novalidate @submit="${handleSubmit}">
        <label class="block">
          <span class="text-sm font-medium text-fg-soft">Email</span>
          <input class="${inputCls}" type="email" autocomplete="username" placeholder="admin@example.com" @input="${/** @type {any} */ (emailField.set)}" />
          ${() => (emailField.error() ? html`<p class="mt-1.5 text-xs" style="color:var(--color-bad)">${() => emailField.error()}</p>` : '')}
        </label>

        <label class="block">
          <span class="text-sm font-medium text-fg-soft">Password</span>
          <input class="${inputCls}" type="password" autocomplete="current-password" placeholder="••••••••" @input="${/** @type {any} */ (passwordField.set)}" />
          ${() => (passwordField.error() ? html`<p class="mt-1.5 text-xs" style="color:var(--color-bad)">${() => passwordField.error()}</p>` : '')}
        </label>

        ${() => (form.message ? html`<p class="text-xs" style="color:var(--color-bad)">${() => form.message}</p>` : '')}

        <button
          type="submit"
          aria-disabled="${() => (form.submitting ? 'true' : 'false')}"
          class="${() => `w-full rounded-control bg-brand px-4 py-2.5 font-semibold text-[#12233f] shadow-panel transition ${form.submitting ? 'cursor-not-allowed opacity-50' : 'hover:bg-brand-hover'}`}"
        >${() => (form.submitting ? 'Signing in…' : 'Sign in')}</button>
      </form>

      <p class="mt-5 text-center font-mono text-[11px] text-fg-faint">cogworks console · v0.1.0</p>
    </div>
  `
}

export default LoginPage
