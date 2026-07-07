import { html } from '@arrow-js/core'
import { go } from '../framework/router.js'
import { routerState } from '../state/routerState.js'
import { ToastContainer } from '../components/ToastContainer.js'
import { GearMark } from '../components/GearMark.js'
import { Icon } from '../components/Icon.js'
import { authState } from '../state/authState.js'

/** Feature nav — Supabase-style: icon + label, clear sections, each its own page. */
const NAV = [
  { group: null, items: [['/', 'Dashboard', 'dashboard']] },
  {
    group: 'Build',
    items: [
      ['/collections', 'Data', 'data'],
      ['/access', 'Auth', 'auth'],
      ['/sql', 'SQL', 'sql'],
      ['/logic', 'Logic', 'logic'],
      ['/ai', 'AI', 'ai'],
      ['/files', 'Storage', 'storage'],
    ],
  },
  {
    group: 'Operate',
    items: [
      ['/realtime', 'Realtime', 'realtime'],
      ['/observe', 'Logs', 'logs'],
      ['/api-docs', 'API', 'apidocs'],
      ['/operations', 'Operations', 'operations'],
      ['/operate', 'Settings', 'settings'],
    ],
  },
]

const isActive = (/** @type {string} */ to) =>
  to === '/' ? routerState.path === '/' : routerState.path === to || routerState.path.startsWith(to + '/')

function sectionLabel() {
  for (const s of NAV) for (const [to, label] of s.items) if (isActive(to)) return label
  return ''
}

function navLink(/** @type {[string,string,string]} */ item) {
  const [to, label, icon] = item
  return html`
    <a
      href="${to}"
      @click="${(/** @type {Event} */ e) => { e.preventDefault(); go(to) }}"
      class="${() => `group relative flex items-center gap-2.5 rounded-control py-2 pl-3.5 pr-2.5 text-sm transition-colors ${
        isActive(to) ? 'bg-brand-tint font-semibold text-brand' : 'font-medium text-fg-soft hover:bg-surface-hover hover:text-fg'
      }`}"
    >
      <span class="${() => `absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-full transition-colors ${isActive(to) ? 'bg-brand' : 'bg-transparent'}`}"></span>
      <span class="${() => (isActive(to) ? 'text-brand' : 'text-fg-faint group-hover:text-fg')}">${Icon({ name: icon, size: 17 })}</span>
      <span>${label}</span>
    </a>`
}

/** @param {any} content */
export function MenuLayout(content) {
  return html`
    <div class="grid min-h-screen grid-cols-[224px_1fr]">
      <aside class="sticky top-0 flex h-screen flex-col border-r border-line bg-surface">
        <div class="flex items-center gap-2.5 px-4 py-4">
          ${GearMark({ size: 26 })}
          <span class="font-display text-lg font-semibold text-fg">Cogworks</span>
        </div>

        <nav class="flex-1 space-y-3 overflow-y-auto px-3 pb-4">
          ${NAV.map(
            (section) => html`
              <div class="space-y-0.5">
                ${section.group ? html`<div class="px-3.5 pb-1.5 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-fg-faint">${section.group}</div>` : ''}
                ${section.items.map((item) => navLink(/** @type {any} */ (item)))}
              </div>`,
          )}
        </nav>

        <details class="relative border-t border-line">
          <summary class="flex cursor-pointer list-none items-center gap-2.5 px-4 py-3 hover:bg-surface-hover [&::-webkit-details-marker]:hidden">
            <span class="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-brand-tint text-xs font-semibold text-brand">${() => (authState.admin?.email?.[0] ?? 'a').toUpperCase()}</span>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-xs font-medium text-fg">${() => authState.admin?.email ?? 'admin'}</span>
              <span class="block text-[10px] text-fg-faint">owner</span>
            </span>
            ${Icon({ name: 'chevronDown', size: 14, class: 'text-fg-faint' })}
          </summary>
          <div class="absolute bottom-full left-3 right-3 mb-1 rounded-panel border border-line bg-surface p-1 shadow-float">
            <button class="flex w-full items-center gap-2 rounded-control px-3 py-2 text-left text-sm text-fg-soft hover:bg-surface-hover" @click="${async () => { await authState.signOut(); go('/login') }}">${Icon({ name: 'logout', size: 15 })} Sign out</button>
          </div>
        </details>
      </aside>

      <div class="flex min-h-screen flex-col">
        <header class="sticky top-0 z-10 flex items-center gap-2 border-b border-line bg-bg/90 px-6 py-3 backdrop-blur">
          <span class="text-sm font-semibold text-fg">${() => sectionLabel()}</span>
          <span class="text-fg-faint">/</span>
          <span class="mono text-xs text-fg-faint">${() => routerState.path}</span>
          <span class="ml-auto flex items-center gap-1.5 text-[11px] text-fg-faint">
            <span class="dot" style="background:var(--color-ok)"></span> online
          </span>
        </header>
        <main class="flex-1 p-6 lg:p-8">${content}</main>
      </div>
    </div>
    ${ToastContainer()}
  `
}
