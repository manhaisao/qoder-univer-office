import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const installed = join(
  homedir(),
  '.qoder-cn',
  'plugins',
  'cache',
  'local',
  'qoder-univer-office',
  '0.4.0'
)
const workspace = join(homedir(), 'AppData', 'Local', 'Temp', 'qoder-univer-installed-smoke')
await rm(workspace, { recursive: true, force: true })
await mkdir(workspace, { recursive: true })

const transport = new StdioClientTransport({
  command: 'C:\\Program Files\\nodejs\\node.exe',
  args: [join(installed, 'server', 'main.mjs')],
  env: {
    ...process.env,
    UNIVER_GATEWAY_PORT: '19093',
    UNIVER_RESOURCE_CACHE: join(workspace, '.cache')
  },
  stderr: 'inherit'
})

const client = new Client(
  { name: 'installed-smoke', version: '0.0.0' },
  { capabilities: { roots: { listChanged: true } } }
)
client.setRequestHandler(ListRootsRequestSchema, async () => ({
  roots: [{ uri: pathToFileURL(workspace).toString(), name: 'smoke' }]
}))
await client.connect(transport)
await new Promise((resolve) => setTimeout(resolve, 300))

const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args })
  if (result.isError) throw new Error(`${name}: ${result.content[0]?.text}`)
  return result
}

const { tools } = await client.listTools()
console.log('installed tools:', tools.length)

const file = join(workspace, 'installed.univer')
await call('univer_new', { file })
const wt = JSON.parse((await call('univer_worktree', { file, action: 'create', name: 'verify' })).content[0].text)
const worktreeId = wt.result.worktreeId
const unit = JSON.parse((await call('univer_unit', { file, worktreeId, action: 'create', kind: 'sheet', name: 'Sheet1' })).content[0].text)
const unitId = unit.result.unitId
await call('univer_execute', {
  file,
  worktreeId,
  unitId,
  code: 'const s = workbook.getActiveSheet(); s.getRange("A1").setValue({ v: "installed", t: 1 }); return s.getRange("A1").getValue();'
})

const opened = JSON.parse((await call('univer_open', { file, worktreeId, unitId, open: false })).content[0].text)
console.log('viewer url:', opened.url)

const response = await fetch(opened.url)
const html = await response.text()
console.log('viewer http:', response.status, response.headers.get('content-type'), 'html bytes:', html.length)
if (response.status !== 200 || !html.toLowerCase().includes('univer')) {
  throw new Error('viewer did not return the Univer page')
}

await client.close()
console.log('installed smoke ok')
