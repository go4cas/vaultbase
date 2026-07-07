import { html } from '@arrow-js/core'

/**
 * A branded metric card. `value`/`note`/`tone` may be functions for reactivity.
 * @param {{ label: string, value: any, note?: any, tone?: any }} props
 */
export function StatCard({ label, value, note, tone }) {
  const toneColor = () => {
    const t = typeof tone === 'function' ? tone() : tone
    return t === 'bad' ? 'var(--color-bad)' : t === 'warn' ? 'var(--color-warn)' : 'var(--color-brand)'
  }
  return html`
    <div class="rounded-panel border border-line bg-surface-raised p-5 shadow-panel">
      <p class="text-sm font-medium text-fg-soft">${label}</p>
      <p class="mt-2 font-display text-3xl font-semibold text-fg">${value}</p>
      ${note ? html`<p class="mt-1 font-mono text-[11px]" style="${() => `color:${toneColor()}`}">${note}</p>` : ''}
    </div>
  `
}
