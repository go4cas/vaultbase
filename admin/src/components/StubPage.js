import { html } from '@arrow-js/core'

/**
 * Placeholder for an IA section not yet built in the spike.
 * @param {{ eyebrow: string, title: string, blurb: string, planned: string[] }} props
 */
export function StubPage({ eyebrow, title, blurb, planned }) {
  return html`
    <div class="space-y-6">
      <div>
        <div class="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">${eyebrow}</div>
        <h1 class="mt-1 font-display text-2xl font-semibold text-fg">${title}</h1>
        <p class="mt-1 max-w-2xl text-sm text-fg-soft">${blurb}</p>
      </div>
      <div class="rounded-panel border border-dashed border-line-strong bg-surface-raised p-6 shadow-panel">
        <div class="flex items-center gap-2">
          <span class="h-1.5 w-1.5 rounded-full" style="background:var(--color-warn)"></span>
          <span class="font-mono text-[11px] uppercase tracking-wider text-fg-faint">planned for this section</span>
        </div>
        <ul class="mt-4 grid gap-2 sm:grid-cols-2">
          ${planned.map(
            (p) => html`
              <li class="flex items-center gap-2.5 rounded-control border border-line bg-surface-inset px-3 py-2.5 text-sm text-fg-soft">
                <span class="font-mono text-brand">›</span>${p}
              </li>
            `,
          )}
        </ul>
      </div>
    </div>
  `
}
