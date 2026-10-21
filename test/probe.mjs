import { Context } from '@deepseek-ai/cordis'
import { GatewayUniverService, resolveConfig } from 'dsh-univer-office'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const workspace = join(tmpdir(), 'qoder-univer-probe')
await (await import('node:fs/promises')).mkdir(workspace, { recursive: true })

const ctx = new Context()
const config = resolveConfig({
  gatewayPort: 19080,
  resourceCacheRoot: join(workspace, 'cache'),
  telemetry: false
})
const service = new GatewayUniverService(ctx, config)

console.log('gateway status:', await service.gatewayStatus())
const ensured = await service.ensureGateway()
console.log('ensure:', ensured)
const file = join(workspace, 'probe.univer')
const created = await service.newFile({ workspace, file })
console.log('newFile:', created)
const wt = await service.worktree({ workspace, file, action: 'create', name: 'probe' })
console.log('worktree:', JSON.stringify(wt))
const wtId = wt.result.worktreeId
const unit = await service.unit({ workspace, file, worktreeId: wtId, action: 'create', kind: 'sheet', name: 'Sheet1' })
console.log('unit:', JSON.stringify(unit))
const unitId = unit.result.unitId
const exec = await service.executeUnitContent({
  workspace,
  file,
  worktreeId: wtId,
  unitId,
  code: 'const sheet = workbook.getActiveSheet(); sheet.getRange("A1").setValue({ v: "hello", t: 1 }); return sheet.getRange("A1").getValue();'
})
console.log('execute:', JSON.stringify(exec))
const inspect = await service.inspectUnitContent({ workspace, file, unitId, worktreeId: wtId, range: 'A1:B2' })
console.log('inspect:', JSON.stringify(inspect).slice(0, 500))
const state = await service.fileState({ workspace, file })
console.log('state:', JSON.stringify(state).slice(0, 800))
await service.dispose()
console.log('done')
