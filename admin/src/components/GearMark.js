import { html } from '@arrow-js/core'

/**
 * The Cogworks two-gear mark, in the lime brand color. Framework-neutral SVG
 * (path data ported from the landing logo).
 * @param {{ size?: number }} [props]
 */
export function GearMark({ size = 32 } = {}) {
  const w = size * 1.6
  return html`
    <svg width="${w}" height="${size}" viewBox="-26 -20 64 40" role="img" aria-label="Cogworks">
      <g transform="translate(-6 1)" fill="none" stroke="var(--color-brand)" stroke-width="1.3" stroke-linejoin="round">
        <path d="M8.6,0.2L12.9,1.1L12.6,2.9L8.2,2.5L6.8,5.2L9.8,8.5L8.5,9.8L5.2,6.8L2.5,8.2L2.9,12.6L1.1,12.9L0.2,8.6L-2.8,8.1L-5.1,11.9L-6.7,11.1L-4.9,7.0L-7.0,4.9L-11.1,6.7L-11.9,5.1L-8.1,2.8L-8.6,-0.2L-12.9,-1.1L-12.6,-2.9L-8.2,-2.5L-6.8,-5.2L-9.8,-8.5L-8.5,-9.8L-5.2,-6.8L-2.5,-8.2L-2.9,-12.6L-1.1,-12.9L-0.2,-8.6L2.8,-8.1L5.1,-11.9L6.7,-11.1L4.9,-7.0L7.0,-4.9L11.1,-6.7L11.9,-5.1L8.1,-2.8Z"></path>
        <circle r="4"></circle>
        <circle r="1.8" fill="var(--color-brand)" stroke="none"></circle>
      </g>
      <g transform="translate(10.51 -7.78)" fill="none" stroke="var(--color-brand)" stroke-width="1.3" stroke-linejoin="round">
        <path d="M5.3,0.1L9.6,1.2L9.2,3.1L4.8,2.2L3.2,4.2L5.0,8.3L3.3,9.1L1.3,5.1L-1.3,5.1L-3.3,9.1L-5.0,8.3L-3.2,4.2L-4.8,2.2L-9.2,3.1L-9.6,1.2L-5.3,0.1L-4.7,-2.4L-8.1,-5.3L-6.9,-6.8L-3.4,-4.0L-1.0,-5.2L-1.0,-9.6L1.0,-9.6L1.0,-5.2L3.4,-4.0L6.9,-6.8L8.1,-5.3L4.7,-2.4Z"></path>
        <circle r="3"></circle>
        <circle r="1.8" fill="var(--color-brand)" stroke="none"></circle>
      </g>
    </svg>
  `
}
