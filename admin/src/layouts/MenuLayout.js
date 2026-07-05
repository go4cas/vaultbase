import { html } from '@arrow-js/core'
import { go } from '../framework/router.js'
import { routerState } from '../state/routerState.js'
import { ToastContainer } from '../components/ToastContainer.js'
import { Link } from '../components/Link.js'
import { GearMark } from '../components/GearMark.js'
import { authState } from '../state/authState.js'

const navItem =
  'flex items-center gap-2.5 rounded-control px-3 py-2 text-sm text-fg-faint transition-colors hover:bg-surface-inset hover:text-fg-soft [&[aria-current=page]]:bg-brand-tint [&[aria-current=page]]:font-semibold [&[aria-current=page]]:text-brand'

const groupLabel = 'px-3 pt-4 pb-1 font-mono text-[10px] uppercase tracking-[0.16em] text-fg-faint/70'

/** The Cogworks console nav — grouped by operator intent (blank-canvas IA). */
const NAV = [
  { group: null, items: [['/', 'Overview']] },
  {
    group: 'Build',
    items: [
      ['/collections', 'Data'],
      ['/access', 'Access'],
      ['/logic', 'Logic'],
      ['/ai', 'AI'],
      ['/files', 'Files'],
    ],
  },
  {
    group: 'Operate',
    items: [
      ['/realtime', 'Realtime'],
      ['/observe', 'Observe'],
      ['/sql', 'SQL runner'],
      ['/operate', 'Settings'],
    ],
  },
]

/** @param {any} content */
export function MenuLayout(content) {
  return html`
    <div class="grid min-h-screen grid-cols-1 lg:grid-cols-[240px_1fr]">
      <aside class="flex flex-col border-b border-line bg-surface-raised lg:border-b-0 lg:border-r">
        <div class="flex items-center gap-2.5 px-5 py-5">
          ${GearMark({ size: 30 })}
          <div class="flex flex-col leading-tight">
            <span class="font-display text-[17px] font-semibold text-brand">Cogworks</span>
            <span class="font-mono text-[9.5px] tracking-wide text-fg-faint">the works, without the work</span>
          </div>
        </div>

        <nav class="flex-1 overflow-y-auto px-3 pb-4">
          ${NAV.map(
            (section) => html`
              ${section.group ? html`<div class="${groupLabel}">${section.group}</div>` : ''}
              ${section.items.map(([to, label]) => Link({ to, children: label, class: navItem }))}
            `,
          )}
        </nav>

        <div class="flex items-center justify-between border-t border-line px-5 py-3">
          <span class="font-mono text-[10px] text-fg-faint">v0.1.0</span>
          <span class="inline-flex items-center gap-1.5 font-mono text-[10px] text-fg-faint">
            <span class="h-1.5 w-1.5 rounded-full" style="background: var(--color-ok)"></span> online
          </span>
        </div>
      </aside>

      <div class="flex min-h-screen flex-col">
        <header class="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-surface-raised/85 px-6 py-3 backdrop-blur-sm">
          <span class="font-mono text-xs text-fg-faint">${() => routerState.path}</span>
          <details class="relative">
            <summary class="flex cursor-pointer list-none items-center gap-2 rounded-full border border-line py-1 pl-3 pr-2 text-sm text-fg-soft [&::-webkit-details-marker]:hidden">
              <span>${() => authState.admin?.email ?? 'admin'}</span>
              <svg class="h-3 w-3 text-fg-faint" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 9l-7 7-7-7" /></svg>
            </summary>
            <div class="absolute right-0 top-full z-50 mt-2 w-44 rounded-panel border border-line bg-surface-raised shadow-float p-1.5">
              <button class="w-full rounded-control px-3 py-2 text-left text-sm text-fg-soft hover:bg-surface-inset" @click="${async () => { await authState.signOut(); go('/login') }}">Sign out</button>
            </div>
          </details>
        </header>

        <main class="flex-1 p-6 lg:p-8">${content}</main>
      </div>
    </div>
    ${ToastContainer()}
  `
}
