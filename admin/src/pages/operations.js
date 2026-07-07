import { html, reactive } from '@arrow-js/core'
import { useMeta } from '../framework/index.js'
import { useToast } from '../composables/useToast.js'
import { api, getToken } from '../lib/api.js'
import { Icon } from '../components/Icon.js'

export const meta = { layout: 'menu', title: 'Operations' }

function OperationsPage() {
  useMeta({ title: 'Operations · Cogworks' })
  const toast = useToast()
  const s = reactive(/** @type {{ busy:string, snapshot:any, diff:any, applyMode:string, applyResult:any }} */ ({ busy: '', snapshot: null, diff: null, applyMode: 'additive', applyResult: null }))
  /** @type {any} */ let uploadedSnap = null

  async function downloadBackup() {
    s.busy = 'backup'
    try {
      const res = await fetch('/api/v1/admin/backup', { headers: { Authorization: `Bearer ${getToken()}` } })
      if (!res.ok) throw new Error(`Backup failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a'); a.href = url; a.download = `cogworks-backup-${new Date().toISOString().slice(0, 10)}.db`; a.click()
      URL.revokeObjectURL(url)
      toast.success('Backup downloaded')
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Backup failed') } finally { s.busy = '' }
  }

  async function restore(/** @type {any} */ e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (!globalThis.confirm(`Restore from "${file.name}"? This OVERWRITES the current database. The server may need a restart.`)) { e.target.value = ''; return }
    s.busy = 'restore'
    try {
      const fd = new FormData(); fd.append('file', file)
      const res = await fetch('/api/v1/admin/restore', { method: 'POST', headers: { Authorization: `Bearer ${getToken()}` }, body: fd })
      const j = await res.json().catch(() => ({}))
      if (!res.ok || j?.error) throw new Error(j?.error || `Restore failed (${res.status})`)
      toast.success('Restore complete')
    } catch (/** @type {any} */ err) { toast.error(err?.message || 'Restore failed') } finally { s.busy = ''; e.target.value = '' }
  }

  async function loadSnapshot() {
    s.busy = 'snapshot'
    try {
      const r = /** @type {any} */ (await api.get('/api/v1/admin/migrations/snapshot'))
      if (r?.error) throw new Error(r.error)
      s.snapshot = r?.data ?? r
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Failed') } finally { s.busy = '' }
  }
  function downloadSnapshot() {
    const blob = new Blob([JSON.stringify(s.snapshot, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a'); a.href = url; a.download = 'cogworks-schema-snapshot.json'; a.click()
    URL.revokeObjectURL(url)
  }

  async function onSnapshotFile(/** @type {any} */ e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    s.diff = null; s.applyResult = null
    s.busy = 'diff'
    try {
      uploadedSnap = JSON.parse(await file.text())
      const r = /** @type {any} */ (await api.post('/api/v1/admin/migrations/diff', { snapshot: uploadedSnap }))
      if (r?.error) throw new Error(r.error)
      s.diff = r?.data ?? null
    } catch (/** @type {any} */ err) { toast.error(err?.message || 'Could not diff snapshot'); uploadedSnap = null } finally { s.busy = '' }
  }
  async function applyMigration() {
    if (!uploadedSnap) return
    const label = s.applyMode === 'sync' ? 'SYNC (may drop columns/collections)' : 'additive'
    if (!globalThis.confirm(`Apply this snapshot in ${label} mode?`)) return
    s.busy = 'apply'
    try {
      const r = /** @type {any} */ (await api.post('/api/v1/admin/migrations/apply', { snapshot: uploadedSnap, mode: s.applyMode }))
      if (r?.error) throw new Error(r.error)
      s.applyResult = r?.data ?? null
      const d = s.applyResult
      if (d?.errors?.length) toast.warning(`Applied with ${d.errors.length} error(s)`)
      else toast.success(`Applied — ${d.created.length} created, ${d.updated.length} updated`)
      s.diff = null; uploadedSnap = null
    } catch (/** @type {any} */ e) { toast.error(e?.message || 'Apply failed') } finally { s.busy = '' }
  }

  return html`
    <div class="space-y-5">
      <div>
        <h1 class="font-display text-2xl font-semibold text-fg">Operations</h1>
        <p class="mt-0.5 text-sm text-fg-soft">Backups, restores, and schema snapshots for your Cogworks server.</p>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="card card-pad space-y-3">
          <div class="card-title">Backup</div>
          <p class="text-sm text-fg-soft">Download a consistent snapshot of the entire SQLite database — schema, records, settings, and tokens.</p>
          <button class="btn btn-primary" aria-disabled="${() => (s.busy === 'backup' ? 'true' : 'false')}" @click="${downloadBackup}">${Icon({ name: 'external', size: 14 })} ${() => (s.busy === 'backup' ? 'Preparing…' : 'Download backup')}</button>
        </div>

        <div class="card card-pad space-y-3">
          <div class="card-title" style="color:var(--color-bad)">Restore</div>
          <p class="text-sm text-fg-soft">Replace the current database with a backup file. <span class="text-fg">Overwrites everything</span> — use with care.</p>
          <label class="btn btn-danger cursor-pointer">
            ${Icon({ name: 'refresh', size: 14 })} ${() => (s.busy === 'restore' ? 'Restoring…' : 'Restore from file')}
            <input type="file" accept=".db,.sqlite,.sqlite3" class="hidden" @change="${restore}" />
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="card-title">Schema snapshot</span>
          <div class="flex gap-2">
            <button class="btn btn-secondary btn-sm" aria-disabled="${() => (s.busy === 'snapshot' ? 'true' : 'false')}" @click="${loadSnapshot}">${() => (s.busy === 'snapshot' ? 'Loading…' : 'Load current')}</button>
            ${() => s.snapshot ? html`<button class="btn btn-secondary btn-sm" @click="${downloadSnapshot}">${Icon({ name: 'external', size: 13 })} Download JSON</button>` : ''}
          </div>
        </div>
        <div class="card-pad">
          <p class="mb-3 text-sm text-fg-soft">A portable description of your collections + fields. Use it to diff and apply schema migrations across environments via the CLI (<span class="mono">cogworks migrate</span>).</p>
          ${() => s.snapshot
            ? html`<pre class="tscroll overflow-x-auto rounded-control bg-surface-inset p-4 text-xs text-fg-soft"><code class="mono">${JSON.stringify(s.snapshot, null, 2)}</code></pre>`
            : html`<div class="rounded-control border border-dashed border-line-strong p-6 text-center text-sm text-fg-faint">Load the current schema snapshot to view or download it.</div>`}
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <span class="card-title">Apply a migration</span>
          <label class="btn btn-secondary btn-sm cursor-pointer">${Icon({ name: 'upload', size: 13 })} ${() => (s.busy === 'diff' ? 'Diffing…' : 'Upload snapshot')}<input type="file" accept=".json,application/json" class="hidden" @change="${onSnapshotFile}" /></label>
        </div>
        <div class="card-pad space-y-4">
          <p class="text-sm text-fg-soft">Upload a schema snapshot from another environment. Cogworks shows what would change, then applies it — <span class="mono text-fg">additive</span> only adds new collections/fields; <span class="mono text-fg">sync</span> also removes what's not in the snapshot.</p>

          ${() => {
            if (s.applyResult) {
              const d = s.applyResult
              return html`<div class="rounded-control border border-line p-4 space-y-2">
                <div class="text-sm font-medium" style="color:var(--color-ok)">Migration applied</div>
                <div class="flex flex-wrap gap-4 text-xs text-fg-soft">
                  <span><span class="mono text-fg">${d.created.length}</span> created</span>
                  <span><span class="mono text-fg">${d.updated.length}</span> updated</span>
                  <span><span class="mono text-fg">${d.skipped.length}</span> skipped</span>
                  <span style="${d.errors.length ? 'color:var(--color-bad)' : ''}"><span class="mono">${d.errors.length}</span> errors</span>
                </div>
                ${d.errors.length ? html`<ul class="mt-1 space-y-0.5 text-xs" style="color:var(--color-bad)">${d.errors.map((/** @type {any} */ er) => html`<li class="mono">${typeof er === 'string' ? er : JSON.stringify(er)}</li>`)}</ul>` : ''}
              </div>`
            }
            if (!s.diff) return html`<div class="rounded-control border border-dashed border-line-strong p-6 text-center text-sm text-fg-faint">Upload a snapshot JSON to preview the diff.</div>`
            const d = s.diff
            const group = (/** @type {string} */ label, /** @type {any[]} */ items, /** @type {string} */ color) => items.length
              ? html`<div><div class="mb-1 text-xs font-semibold" style="${`color:${color}`}">${label} (${items.length})</div><div class="space-y-1">${items.map((/** @type {any} */ it) => html`
                  <div class="rounded bg-surface-inset px-2.5 py-1.5 text-xs">
                    <span class="mono text-fg">${it.name}</span>${it.type ? html`<span class="ml-1.5 text-fg-faint">${it.type}</span>` : ''}
                    ${it.changes?.length ? html`<ul class="mt-1 ml-3 list-disc space-y-0.5 text-fg-faint">${it.changes.map((/** @type {any} */ ch) => html`<li>${typeof ch === 'string' ? ch : JSON.stringify(ch)}</li>`)}</ul>` : ''}
                  </div>`.key(it.name))}</div></div>`
              : ''
            return html`
              <div class="grid gap-4 sm:grid-cols-2">
                ${group('Added', d.added, 'var(--color-ok)')}
                ${group('Modified', d.modified, 'var(--color-warn)')}
                ${group('Removed', d.removed, 'var(--color-bad)')}
                ${d.unchanged.length ? html`<div><div class="mb-1 text-xs font-semibold text-fg-faint">Unchanged (${d.unchanged.length})</div></div>` : ''}
              </div>
              <div class="flex items-center gap-3 border-t border-line pt-3">
                <label class="flex items-center gap-1.5 text-xs text-fg-soft">Mode
                  <select class="select" style="width:9rem" @change="${(/** @type {any} */ e) => { s.applyMode = e.target.value }}">${['additive', 'sync'].map((m) => html`<option value="${m}">${m}</option>`.key(m))}</select>
                </label>
                <button class="btn btn-primary" aria-disabled="${() => (s.busy === 'apply' ? 'true' : 'false')}" @click="${applyMigration}">${() => (s.busy === 'apply' ? 'Applying…' : 'Apply migration')}</button>
                ${(d.added.length + d.modified.length + d.removed.length) === 0 ? html`<span class="text-xs text-fg-faint">Nothing to apply — already in sync.</span>` : ''}
              </div>`
          }}
        </div>
      </div>
    </div>
  `
}

export default OperationsPage
