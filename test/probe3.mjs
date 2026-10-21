import { Context } from '@deepseek-ai/cordis'
import { GatewayUniverService, resolveConfig } from 'dsh-univer-office'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const workspace = join(tmpdir(), 'qoder-univer-probe3')
await mkdir(workspace, { recursive: true })
const service = new GatewayUniverService(new Context(), resolveConfig({
  gatewayPort: 19094,
  resourceCacheRoot: join(workspace, 'cache'),
  telemetry: false
}))

const file = join(workspace, 'deck.univer')
await service.newFile({ workspace, file })
const wt = await service.worktree({ workspace, file, action: 'create', name: 'deck' })
const worktreeId = wt.result.worktreeId

const slide = await service.unit({ workspace, file, worktreeId, action: 'create', kind: 'slide', name: 'Deck' })
const slideId = slide.result.unitId
console.log('slide unit:', slideId)

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540">
  <rect x="0" y="0" width="960" height="540" fill="#ffffff"/>
  <text x="80" y="140" font-family="Arial" font-size="64" fill="#111111">Univer Office</text>
  <text x="80" y="220" font-family="Arial" font-size="28" fill="#555555">Qoder MCP plugin</text>
  <rect x="80" y="300" width="800" height="8" fill="#2563eb"/>
</svg>`
const svgPath = join(workspace, 'page.svg')
await writeFile(svgPath, svg)

try {
  const compiled = await service.compileSvg({
    workspace, file, source: svgPath, sourceWorkspace: workspace,
    worktreeId, unitId: slideId, page: 1
  })
  console.log('compile-svg:', JSON.stringify(compiled).slice(0, 500))
} catch (error) {
  console.log('COMPILE FAILED:', error.code, error.message)
}

try {
  const lint = await service.lintUnitLayout({ workspace, file, unitId: slideId, worktreeId })
  console.log('lint:', JSON.stringify(lint).slice(0, 600))
} catch (error) {
  console.log('LINT FAILED:', error.code, error.message)
}

try {
  const shot = await service.screenshotUnit({
    workspace, file, unitId: slideId, worktreeId,
    outputWorkspace: workspace, output: join(workspace, 'slide-shots')
  })
  console.log('slide screenshot:', shot.result.images.map((i) => i.name))
} catch (error) {
  console.log('SLIDE SHOT FAILED:', error.code, error.message)
}

try {
  const pptx = await service.exportUnitContent({
    workspace, file, unitId: slideId, worktreeId,
    outputWorkspace: workspace, output: join(workspace, 'deck.pptx')
  })
  console.log('pptx:', pptx.result.outputPath, (await stat(join(workspace, 'deck.pptx'))).size)
} catch (error) {
  console.log('PPTX FAILED:', error.code, error.message)
}

const doc = await service.unit({ workspace, file, worktreeId, action: 'create', kind: 'doc', name: 'Report' })
const docId = doc.result.unitId
await service.executeUnitContent({
  workspace, file, worktreeId, unitId: docId,
  code: 'const body = doc.getBody(); body.insertText(0, "Quarterly report"); return body.getText();'
}).then((r) => console.log('doc execute:', JSON.stringify(r).slice(0, 300)))
  .catch((e) => console.log('DOC EXEC FAILED:', e.code, e.message))
try {
  const docx = await service.exportUnitContent({
    workspace, file, unitId: docId, worktreeId,
    outputWorkspace: workspace, output: join(workspace, 'report.docx')
  })
  console.log('docx:', docx.result.outputPath, (await stat(join(workspace, 'report.docx'))).size)
} catch (error) {
  console.log('DOCX FAILED:', error.code, error.message)
}

try {
  const wt2 = await service.worktree({ workspace, file, action: 'create', name: 'reimport' })
  const imported = await service.importUnitContent({
    workspace, file, worktreeId: wt2.result.worktreeId, name: 'Deck back',
    sourceWorkspace: workspace, source: join(workspace, 'deck.pptx')
  })
  console.log('pptx import:', JSON.stringify(imported).slice(0, 300))
} catch (error) {
  console.log('PPTX IMPORT FAILED:', error.code, error.message)
}

await service.dispose()
console.log('probe3 done')
