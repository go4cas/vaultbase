import { component, html, onCleanup } from '@arrow-js/core'
import { Icon } from './Icon.js'

let dialogSeq = 0

const FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'

/**
 * Accessible modal dialog — arrow-native. Provides role="dialog" + aria-modal,
 * Escape-to-close, a focus trap (Tab/Shift-Tab cycle within), initial focus, and
 * focus restore to the trigger element when the dialog unmounts. Render it
 * conditionally, e.g. `${() => state.open ? Dialog({ title, onClose, children }) : ''}`.
 * Lifecycle hooks require component() (arrow.js constraint).
 */
export const Dialog = component(
  /** @param {{ title: any, onClose: () => void, children: any, size?: string }} props */
  ({ title, onClose, children, size = 'max-w-3xl' }) => {
  const id = `cw-dialog-${dialogSeq++}`
  const titleId = `${id}-title`
  // Whatever had focus when the dialog opened (usually the trigger button).
  const restoreTo = /** @type {any} */ (document.activeElement)

  /** @param {any} e */
  function onKeydown(e) {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key !== 'Tab') return
    const root = document.getElementById(id)
    if (!root) return
    const items = /** @type {HTMLElement[]} */ ([...root.querySelectorAll(FOCUSABLE)]
      .filter((el) => /** @type {HTMLElement} */ (el).offsetParent !== null))
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && active === first) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
  }

  // Escape + Tab-trap on the document (capture) — robust regardless of focus timing.
  document.addEventListener('keydown', onKeydown, true)

  // nextTick races the DOM commit (see Monaco), so poll on rAF until connected.
  let tries = 0
  function focusIn() {
    const root = document.getElementById(id)
    if (!root || !root.isConnected) { if (tries++ < 60) requestAnimationFrame(focusIn); return }
    const panel = /** @type {HTMLElement|null} */ (root.querySelector('[role="dialog"]'))
    const focusable = /** @type {HTMLElement|null} */ (root.querySelector(FOCUSABLE))
    ;(focusable ?? panel)?.focus()
  }
  requestAnimationFrame(focusIn)

  onCleanup(() => {
    document.removeEventListener('keydown', onKeydown, true)
    if (restoreTo && typeof restoreTo.focus === 'function') restoreTo.focus()
  })

  return html`
    <div id="${id}" class="fixed inset-0 z-30 flex items-start justify-center overflow-y-auto bg-black/50 p-6"
      @click="${(/** @type {any} */ e) => { if (e.target === e.currentTarget) onClose() }}">
      <div class="${`card w-full ${size}`}" role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1">
        <div class="card-head">
          <span id="${titleId}" class="card-title">${title}</span>
          <button class="btn btn-ghost btn-icon" aria-label="Close dialog" @click="${() => onClose()}">${Icon({ name: 'x', size: 15 })}</button>
        </div>
        ${children}
      </div>
    </div>`
  },
)
