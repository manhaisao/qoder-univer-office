import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const workspace = join(tmpdir(), 'qoder-univer-mcp-smoke')
await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(import.meta.dirname, '..', 'server', 'main.mjs')],
  env: {
    ...process.env,
    UNIVER_WORKSPACE: workspace,
    UNIVER_GATEWAY_PORT: '19092',
    UNIVER_RESOURCE_CACHE: join(workspace, '.cache')
  },
  stderr: 'inherit'
})

const client = new Client({ name: 'smoke', version: '0.0.0' })
await client.connect(transport)

const { tools } = await client.listTools()
console.log('tools:', tools.length, tools.map((tool) => tool.name).join(', '))

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`)
  return result
}

const file = join(workspace, 'demo.univer')
await call('univer_new', { file })
const wt = await call('univer_worktree', { file, action: 'create', name: 'first' })
const wtId = JSON.parse(wt.content[0].text).result.worktreeId
const unit = await call('univer_unit', { file, worktreeId: wtId, action: 'create', kind: 'sheet', name: 'Data' })
const unitId = JSON.parse(unit.content[0].text).result.unitId

const executed = await call('univer_execute', {
  file,
  worktreeId: wtId,
  unitId,
  code: 'const s = workbook.getActiveSheet(); s.getRange("A1").setValue({ v: "x", t: 1 }); s.getRange("A2").setValue({ v: 41, t: 2 }); s.getRange("A3").setFormula("=A2+1"); return s.getRange("A1:A3").getDisplayValues();'
})
console.log('execute:', executed.content[0].text)

const inspected = await call('univer_inspect', { file, worktreeId: wtId, unitId, range: 'A1:A3' })
console.log('inspect:', inspected.content[0].text.slice(0, 300))

const shot = await call('univer_screenshot', {
  file,
  worktreeId: wtId,
  unitId,
  output: join(workspace, 'shots'),
  range: 'A1:A3'
})
console.log('screenshot blocks:', shot.content.map((block) => block.type).join(','))

const exported = await call('univer_export', {
  file,
  worktreeId: wtId,
  unitId,
  output: join(workspace, 'demo.xlsx')
})
console.log('export:', exported.content[0].text)
console.log('xlsx size:', (await stat(join(workspace, 'demo.xlsx'))).size)

const opened = await call('univer_open', { file, worktreeId: wtId, unitId, open: false })
console.log('open url:', JSON.parse(opened.content[0].text).url)

const gateway = await call('univer_gateway', { action: 'status' })
console.log('gateway:', gateway.content[0].text)

await client.close()
console.log('smoke ok')
