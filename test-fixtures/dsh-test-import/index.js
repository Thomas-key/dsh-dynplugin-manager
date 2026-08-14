// dsh-test-import — minimal import-using cordis plugin.
//
// Purpose: verify that a community-style npm plugin (one that USES import
// statements for real packages) can be mounted through the loader channel
// (insert row + official patch watcher HMR), unlike the runner channel whose
// vm sandbox forbids module loading.
//
// Imports:
//   - '@deepseek-ai/schemastery'  (real DSH-ecosystem package, default export)
//   - 'node:path' / 'node:fs'     (builtins)
//
// If ANY import fails to resolve, the whole module fails to load and the flag
// file is never written — so the flag is a strict proof that import worked.
import z from '@deepseek-ai/schemastery'
import { join } from 'node:path'
import { writeFileSync, mkdirSync } from 'node:fs'

export const name = 'dsh-test-import'

const FLAG = 'C:/Users/illus/Desktop/deepseekharnes/.insert-test/flag-import-mounted.txt'

export function apply() {
  // Actually USE the imported package: build a schema and render it. If the
  // import had been stripped/failed, `z` would be undefined and this throws.
  const schema = z.object({ x: z.number(), note: z.string() })
  const rendered = String(schema)
  try {
    mkdirSync(FLAG.replace(/\/[^/]+$/, ''), { recursive: true })
    writeFileSync(FLAG, 'mounted at ' + new Date().toISOString() + '\nimport-ok schema=' + rendered + '\n', 'utf8')
  } catch (error) {
    console.error('[dsh-test-import] flag write failed:', String(error))
  }
  console.log('[dsh-test-import] apply() called — mounted without restart, schema=' + rendered)
}
