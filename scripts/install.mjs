import { cp, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const QODER_HOME = join(homedir(), '.qoder-cn')
const PLUGIN_NAME = 'qoder-univer-office'
const MARKET = 'local'
const KEY = `${PLUGIN_NAME}@${MARKET}`
const pkg = JSON.parse(await readFile(join(SOURCE, 'package.json'), 'utf8'))
const VERSION = pkg.version
const TARGET = join(QODER_HOME, 'plugins', 'cache', MARKET, PLUGIN_NAME, VERSION)

if (!existsSync(join(QODER_HOME, 'plugins'))) {
  throw new Error(`Qoder data directory not found: ${QODER_HOME}`)
}

console.log(`Installing ${PLUGIN_NAME}@${VERSION}`)
console.log(`  from ${SOURCE}`)
console.log(`  to   ${TARGET}`)

await rm(TARGET, { recursive: true, force: true })
await mkdir(TARGET, { recursive: true })

for (const entry of [
  'server',
  'skills',
  '.qoder-plugin',
  'package.json',
  'README.md',
  'LICENSE'
]) {
  await cp(join(SOURCE, entry), join(TARGET, entry), { recursive: true })
}

console.log('Copying runtime dependencies (about 350 MB)...')
await cp(join(SOURCE, 'node_modules'), join(TARGET, 'node_modules'), {
  recursive: true,
  dereference: true
})

const template = await readFile(join(SOURCE, 'mcp.template.json'), 'utf8')
const escapedTarget = TARGET.replaceAll('\\', '\\\\')
const mcp = template
  .replaceAll('__NODE__', process.execPath.replaceAll('\\', '\\\\'))
  .replaceAll('__PLUGIN_ROOT__', escapedTarget)
await writeFile(join(TARGET, 'mcp.json'), mcp)

const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
async function updateJson(file, mutate) {
  const text = await readFile(file, 'utf8')
  await copyFile(file, `${file}.bak-${stamp}`)
  const value = JSON.parse(text)
  mutate(value)
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

const installedPath = join(QODER_HOME, 'plugins', 'installed_plugins_v2.json')
await updateJson(installedPath, (value) => {
  value.version = 2
  value.plugins ??= {}
  const entry = {
    scope: 'user',
    installPath: TARGET,
    version: VERSION,
    installedAt: new Date().toISOString(),
    lastUpdated: new Date().toISOString(),
    displayName: 'Univer Office',
    userVisible: true,
    appRowId: `local:plugin:${PLUGIN_NAME}`
  }
  value.plugins[KEY] = [entry]
})

await updateJson(join(QODER_HOME, 'settings.json'), (value) => {
  value.enabledPlugins ??= {}
  value.enabledPlugins[KEY] = true
})

console.log('')
console.log(`Installed ${KEY} -> ${TARGET}`)
console.log('Restart Qoder, then open Settings > Plugins and confirm "Univer Office" is enabled.')
console.log('The MCP server starts with Qoder and exposes 16 univer_* tools.')
