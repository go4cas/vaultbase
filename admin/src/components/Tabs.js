import { html } from '@arrow-js/core'

/**
 * Accessible tab list. Renders role="tablist" with role="tab" buttons, reactive
 * aria-selected, roving tabindex, and Left/Right/Home/End keyboard navigation
 * (automatic activation — moving with the arrows selects + focuses the tab).
 * Keeps the existing `border-b-2 border-brand` active style.
 * @param {{ tabs: Array<{id:string,label:any}>, active: () => string, onSelect: (id:string)=>void, class?: string }} props
 */
export function TabList({ tabs, active, onSelect, class: cls = '' }) {
  /** @param {any} e @param {number} i */
  function onKey(e, i) {
    let n = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % tabs.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + tabs.length) % tabs.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = tabs.length - 1
    else return
    e.preventDefault()
    const id = tabs[n].id
    onSelect(id)
    const el = /** @type {HTMLElement|null} */ (e.currentTarget.parentElement?.querySelector(`[data-tab="${id}"]`))
    el?.focus()
  }
  return html`
    <div role="tablist" class="${`flex flex-wrap gap-5 border-b border-line ${cls}`}">
      ${tabs.map((t, i) => html`
        <button
          role="tab"
          data-tab="${t.id}"
          id="${`tab-${t.id}`}"
          aria-selected="${() => (active() === t.id ? 'true' : 'false')}"
          tabindex="${() => (active() === t.id ? '0' : '-1')}"
          @keydown="${(/** @type {any} */ e) => onKey(e, i)}"
          @click="${() => onSelect(t.id)}"
          class="${() => `border-b-2 px-1 pb-2.5 pt-1 text-sm font-medium transition-colors ${active() === t.id ? 'border-brand text-fg' : 'border-transparent text-fg-faint hover:text-fg-soft'}`}"
        >${t.label}</button>`.key(t.id))}
    </div>`
}
