import { Context } from '@deepseek-ai/cordis'
import { GatewayUniverService, resolveConfig } from 'dsh-univer-office'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const workspace = join(tmpdir(), 'qoder-univer-probe')
await mkdir(workspace, { recursive: true })
const ctx = new Context()
const service = new GatewayUniverService(ctx, resolveConfig({
  gatewayPort: 19081,
  resourceCacheRoot: join(workspace, 'cache'),
  telemetry: false
}))

const file = join(workspace, 'probe.univer')
const status = await service.status({ workspace, file })
console.log('status:', JSON.stringify(status).slice(0, 400))
const wtId = status.result.worktrees[0].worktreeId
const wtStatus = await service.status({ workspace, file, worktreeId: wtId })
const unitId = wtStatus.result.selectedWorktree.units[0].unitId

try {
  const exported = await service.exportUnitContent({
    workspace, file, unitId, worktreeId: wtId,
    outputWorkspace: workspace, output: join(workspace, 'probe-export.xlsx')
  })
  console.log('export:', JSON.stringify(exported).slice(0, 400))
  console.log('xlsx exists:', (await stat(join(workspace, 'probe-export.xlsx'))).size)
} catch (error) {
  console.log('EXPORT FAILED:', error.code, error.message, error.cause?.message)
}

try {
  const wt2 = await service.worktree({ workspace, file, action: 'create', name: 'import-test' })
  const imported = await service.importUnitContent({
    workspace, file, worktreeId: wt2.result.worktreeId, name: 'Imported',
    sourceWorkspace: workspace, source: join(workspace, 'probe-export.xlsx')
  })
  console.log('import:', JSON.stringify(imported).slice(0, 400))
} catch (error) {
  console.log('IMPORT FAILED:', error.code, error.message, error.cause?.message)
}

try {
  const shot = await service.screenshotUnit({
    workspace, file, unitId, worktreeId: wtId,
    outputWorkspace: workspace, output: join(workspace, 'shots'),
    target: { kind: 'sheet-range', range: 'A1:B2' }
  })
  console.log('screenshot:', JSON.stringify(shot.result.images.map(i => ({ name: i.name, w: i.width, h: i.height, bytes: i.data.length }))))
} catch (error) {
  console.log('SCREENSHOT FAILED:', error.code, error.message, error.cause?.message)
}

try {
  const pdf = await service.printUnitPdf({
    workspace, file, unitId, worktreeId: wtId,
    outputWorkspace: workspace, output: join(workspace, 'probe.pdf')
  })
  console.log('pdf:', JSON.stringify(pdf).slice(0, 300))
} catch (error) {
  console.log('PDF FAILED:', error.code, error.message, error.cause?.message)
}

try {
  const api = await service.apiReference({ action: 'find', queries: ['setValue'], limit: 3 })
  console.log('api:', JSON.stringify(api).slice(0, 300))
} catch (error) {
  console.log('API FAILED:', error.code, error.message)
}

try {
  const regs = await service.resources({ action: 'registries' })
  console.log('registries:', JSON.stringify(regs).slice(0, 400))
} catch (error) {
  console.log('RESOURCES FAILED:', error.code, error.message)
}

await service.dispose()
