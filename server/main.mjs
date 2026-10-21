import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListRootsResultSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js'
import { Context } from '@deepseek-ai/cordis'
import { GatewayUniverService, resolveConfig } from 'dsh-univer-office'
import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const DEBUG = process.env.UNIVER_DEBUG === '1'

class PortError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

let service
let defaultWorkspace =
  process.env.UNIVER_WORKSPACE?.trim() ||
  process.env.QODER_WORKSPACE?.trim() ||
  process.cwd()

const server = new Server(
  { name: 'univer-office', version: PACKAGE.version },
  { capabilities: { tools: {} } }
)

server.oninitialized = async () => {
  try {
    const result = await server.request({ method: 'roots/list' }, ListRootsResultSchema)
    const root = result.roots?.find((entry) => entry.uri?.startsWith('file:'))
    if (root !== undefined) defaultWorkspace = fileURLToPath(root.uri)
  } catch {
    // Client does not expose roots; tools still accept an explicit workspace.
  }
}

function log(...args) {
  if (DEBUG) process.stderr.write(`[univer-office] ${args.join(' ')}\n`)
}

function getService() {
  if (service !== undefined) return service

  const ctx = new Context()
  const cacheRoot =
    process.env.UNIVER_RESOURCE_CACHE?.trim() || join(PLUGIN_ROOT, '.data', 'resources')
  const port = Number(process.env.UNIVER_GATEWAY_PORT ?? '19090')
  const browser = process.env.UNIVER_RENDER_BROWSER?.trim()

  service = new GatewayUniverService(
    ctx,
    resolveConfig({
      gatewayPort: Number.isSafeInteger(port) && port > 0 ? port : 19090,
      gatewayStartupTimeoutMs: 20_000,
      gatewayRequestTimeoutMs: 5_000,
      gatewayMutationTimeoutMs: 120_000,
      unitContentOperationTimeoutMs: 180_000,
      screenshotOperationTimeoutMs: 180_000,
      printPdfOperationTimeoutMs: 180_000,
      screenshotMaxPages: 30,
      resourceCacheRoot: cacheRoot,
      resourceDownloadTimeoutMs: 20_000,
      resourceOperationTimeoutMs: 180_000,
      telemetry: false,
      ...(browser === undefined ? {} : { browserExecutablePath: browser })
    })
  )
  return service
}

async function resolveWorkspace(args = {}) {
  const candidate = (args.workspace ?? '').trim() || defaultWorkspace
  try {
    return await realpath(candidate)
  } catch (error) {
    throw new PortError(
      `workspace ${JSON.stringify(candidate)} is not accessible: ${error.message}`,
      'SESSION_SCOPE_UNAVAILABLE'
    )
  }
}

function assertInside(workspace, target) {
  const fromWorkspace = relative(workspace, target)
  if (
    fromWorkspace === '..' ||
    fromWorkspace.startsWith(`..${sep}`) ||
    isAbsolute(fromWorkspace)
  ) {
    throw new PortError('path is outside the session workspace', 'SESSION_SCOPE_DENIED')
  }
}

async function resolveFile(workspace, value, options = {}) {
  const { mustExist = true, univer = true } = options
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new PortError('path is required', 'INVALID_FILE_PATH')
  }
  const candidate = isAbsolute(value) ? resolve(value) : resolve(workspace, value)
  let canonical
  if (mustExist) {
    try {
      canonical = await realpath(candidate)
    } catch (error) {
      throw new PortError(
        `path ${JSON.stringify(value)} does not exist or cannot be resolved`,
        'INVALID_FILE_PATH'
      )
    }
  } else {
    canonical = candidate
  }
  assertInside(workspace, canonical)
  if (univer && extname(canonical).toLowerCase() !== '.univer') {
    throw new PortError('Univer file path must end in .univer.', 'INVALID_FILE_PATH')
  }
  return canonical
}

function stripEnvelope(value) {
  const result = value?.result
  if (
    result === null ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    result.error?.code !== 1
  ) {
    return value
  }
  const { error: _ok, ...rest } = result
  return { ...value, result: rest }
}

function normalizePages(pages) {
  if (pages === undefined) return undefined
  return pages.map((selector) => {
    if (typeof selector === 'number') return selector
    const value = String(selector).trim()
    if (value.length === 0) {
      throw new PortError('page selectors must be non-empty.', 'INVALID_REQUEST')
    }
    return /^\d+$/u.test(value) ? Number(value) : value
  })
}

function screenshotTarget(args) {
  const usesSheet = args.sheetName !== undefined || args.range !== undefined
  const usesSlide =
    args.pages !== undefined ||
    args.contactSheet === true ||
    args.tileColumns !== undefined ||
    args.tileRows !== undefined
  const usesBoard =
    args.region !== undefined || args.elementIds !== undefined || args.padding !== undefined
  if ([usesSheet, usesSlide, usesBoard].filter(Boolean).length > 1) {
    throw new PortError(
      'Sheet, paged-Unit, and Board screenshot selectors cannot be combined.',
      'SCREENSHOT_INPUT_INVALID'
    )
  }
  if (args.scale !== undefined && (args.scale < 0.1 || args.scale > 4)) {
    throw new PortError('Screenshot scale must be between 0.1 and 4.', 'SCREENSHOT_INPUT_INVALID')
  }
  if (usesSheet) {
    if (typeof args.range !== 'string' || args.range.trim().length === 0) {
      throw new PortError('range requires a non-empty A1 range.', 'SCREENSHOT_INPUT_INVALID')
    }
    return {
      target: {
        kind: 'sheet-range',
        range: args.range,
        ...(args.sheetName === undefined ? {} : { sheetName: args.sheetName }),
        ...(args.scale === undefined ? {} : { scale: args.scale })
      }
    }
  }
  if (usesSlide) {
    const hasColumns = args.tileColumns !== undefined
    const hasRows = args.tileRows !== undefined
    if (hasColumns !== hasRows || (hasColumns && args.contactSheet !== true)) {
      throw new PortError(
        'tileColumns and tileRows must be provided together with contactSheet.',
        'SCREENSHOT_INPUT_INVALID'
      )
    }
    const tile =
      args.tileColumns === undefined || args.tileRows === undefined
        ? undefined
        : { columns: args.tileColumns, rows: args.tileRows }
    return {
      target: {
        kind: 'paged-unit',
        ...(args.pages === undefined ? {} : { pages: normalizePages(args.pages) }),
        ...(args.contactSheet === true ? { contactSheet: tile === undefined ? {} : { tile } } : {}),
        ...(args.scale === undefined ? {} : { scale: args.scale })
      }
    }
  }
  if (usesBoard) {
    return {
      target: {
        kind: 'board-content',
        ...(args.region === undefined ? {} : { region: args.region }),
        ...(args.elementIds === undefined ? {} : { elementIds: args.elementIds }),
        ...(args.padding === undefined ? {} : { padding: args.padding }),
        ...(args.scale === undefined ? {} : { scale: args.scale })
      }
    }
  }
  if (args.scale !== undefined) return { target: { kind: 'unit-viewport', scale: args.scale } }
  return {}
}

function openInBrowser(url) {
  const command =
    process.platform === 'win32' ? 'cmd' : process.platform === 'darwin' ? 'open' : 'xdg-open'
  const argv =
    process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, argv, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
}

function text(value) {
  return { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }
}

function errorResult(error) {
  const code = error?.code ?? 'TOOL_ERROR'
  const message = error instanceof Error ? error.message : String(error)
  log(`error ${code}: ${message}`)
  return { isError: true, content: [text(`Error [${code}]: ${message}`)] }
}

const workspaceField = {
  type: 'string',
  description:
    'Optional absolute project/workspace root. Defaults to the current Qoder project root (or UNIVER_WORKSPACE).'
}

const fileField = {
  type: 'string',
  description: 'Workspace-relative or absolute .univer path.'
}

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { ...properties, workspace: workspaceField },
      required,
      additionalProperties: false
    }
  }
}

const TOOLS = [
  tool(
    'univer_new',
    'Create a new empty .univer file in the current workspace. Never overwrites an existing file and does not create an implicit Unit.',
    { file: fileField },
    ['file']
  ),
  tool(
    'univer_status',
    'List trunk Units and worktrees for a .univer file, or inspect one worktree scope. Call this before choosing unitId or continuing prior work.',
    {
      file: fileField,
      worktreeId: { type: 'string', description: 'Optional worktree whose Units should be returned.' },
      unitId: { type: 'string', description: 'Optional Unit filter.' }
    },
    ['file']
  ),
  tool(
    'univer_worktree',
    'Create or transition an isolated Univer worktree. Actions: create, ready, reopen, merge, or discard. Merge and discard change review state; use only when the user explicitly asks.',
    {
      action: {
        type: 'string',
        enum: ['create', 'ready', 'reopen', 'merge', 'discard'],
        description: 'Lifecycle action.'
      },
      file: fileField,
      worktreeId: { type: 'string', description: 'Required for every action except create.' },
      name: { type: 'string', description: 'Optional human-readable name for create.' }
    },
    ['action', 'file']
  ),
  tool(
    'univer_unit',
    'Create or remove a top-level Sheet, Doc, Slide, Base, or Board Unit inside an explicit draft worktree.',
    {
      action: { type: 'string', enum: ['create', 'remove'], description: 'Unit lifecycle action.' },
      file: fileField,
      worktreeId: { type: 'string', description: 'Writable draft worktree id.' },
      kind: {
        type: 'string',
        enum: ['sheet', 'doc', 'slide', 'base', 'board'],
        description: 'Required for create.'
      },
      name: { type: 'string', description: 'Required non-empty Unit name for create.' },
      unitId: { type: 'string', description: 'Required for remove.' }
    },
    ['action', 'file', 'worktreeId']
  ),
  tool(
    'univer_import',
    'Import an xlsx, csv, tsv, docx, or pptx file as a new Unit inside an explicit draft worktree.',
    {
      source: {
        type: 'string',
        description: 'Workspace-relative or absolute Office source path.'
      },
      file: fileField,
      worktreeId: { type: 'string', description: 'Writable draft worktree id.' },
      name: { type: 'string', description: 'Name for the imported Unit.' },
      docType: {
        type: 'string',
        enum: ['traditional', 'modern'],
        description:
          'Doc import mode, .docx only. traditional (default) keeps source page setup; modern converts to a pageless document.'
      }
    },
    ['source', 'file', 'worktreeId', 'name']
  ),
  tool(
    'univer_inspect',
    'Inspect structured Univer content. Sheet accepts an optional range; Base and Board default to selector-free overviews; elementIds reads Board elements by exact id.',
    {
      file: fileField,
      unitId: { type: 'string', description: 'Explicit target Unit id from univer_status.' },
      range: { type: 'string', description: 'Optional unit range such as Sheet1!A1:D20.' },
      elementIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'One or more exact Board element IDs for type-specific detail.'
      },
      worktreeId: { type: 'string', description: 'Optional worktree scope; omit to inspect trunk.' }
    },
    ['file', 'unitId']
  ),
  tool(
    'univer_execute',
    'Execute Univer Facade JavaScript and commit mutations to a draft worktree. Use code only for a small snippet and codeFile for multiline code. Provide exactly one source. Explicitly return readback values; console.log does not populate value. Read-only code creates no revision.',
    {
      file: fileField,
      code: {
        type: 'string',
        description: 'Inline Facade code. Mutually exclusive with codeFile.'
      },
      codeFile: {
        type: 'string',
        description: 'Workspace-relative or absolute multiline Facade JavaScript body file.'
      },
      worktreeId: { type: 'string', description: 'Writable agent worktree id.' },
      unitId: { type: 'string', description: 'Target unit id.' }
    },
    ['file', 'worktreeId', 'unitId']
  ),
  tool(
    'univer_export',
    'Export a .univer Unit to a user-facing file format: Sheet to xlsx/csv/tsv, Doc to docx, Slide to pptx. Board export is unsupported.',
    {
      file: fileField,
      output: { type: 'string', description: 'Workspace-relative or absolute output file path.' },
      unitId: { type: 'string', description: 'Explicit Unit id from univer_status.' },
      worktreeId: { type: 'string', description: 'Optional worktree scope; omit to export trunk.' }
    },
    ['file', 'output', 'unitId']
  ),
  tool(
    'univer_lint',
    'Analyze Slide text layout for off-page content, escaped containers, and text overlap without producing screenshots.',
    {
      file: fileField,
      unitId: { type: 'string', description: 'Explicit Slide Unit id from univer_status.' },
      worktreeId: { type: 'string', description: 'Optional worktree scope; omit to lint trunk.' },
      pages: {
        type: 'array',
        items: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
        description: 'Optional 1-based page numbers or page IDs. Omit to lint every page.'
      }
    },
    ['file', 'unitId']
  ),
  tool(
    'univer_compile_svg',
    'Compile an SVG with real font metrics and apply it to one explicit Slide page in a draft worktree.',
    {
      source: { type: 'string', description: 'Workspace-relative or absolute SVG source path.' },
      file: fileField,
      worktreeId: { type: 'string', description: 'Writable draft worktree id.' },
      unitId: { type: 'string', description: 'Explicit Slide Unit id from univer_status.' },
      page: { type: 'integer', description: '1-based Slide page number.' },
      mode: {
        type: 'string',
        enum: ['replace', 'add'],
        description: 'Replace the page contents by default, or add the SVG as an overlay.'
      }
    },
    ['source', 'file', 'worktreeId', 'unitId', 'page']
  ),
  tool(
    'univer_screenshot',
    'Render one explicit Sheet, Doc, Slide, Base, or Board Unit to PNG files and return the images for visual verification.',
    {
      file: fileField,
      unitId: { type: 'string', description: 'Explicit Unit id from univer_status.' },
      worktreeId: { type: 'string', description: 'Optional worktree scope; omit to capture trunk.' },
      output: {
        type: 'string',
        description: 'Workspace-relative or absolute output directory for PNG files.'
      },
      sheetName: { type: 'string', description: 'Sheet name used with range.' },
      range: { type: 'string', description: 'Sheet A1 range such as B2:H40.' },
      pages: {
        type: 'array',
        items: { oneOf: [{ type: 'integer' }, { type: 'string' }] },
        description: 'Doc numeric pages or Slide page numbers/IDs. Omit to capture every page.'
      },
      contactSheet: { type: 'boolean', description: 'Also create one Slide contact sheet.' },
      tileColumns: {
        type: 'integer',
        description: 'Contact-sheet grid columns; requires contactSheet and tileRows.'
      },
      tileRows: {
        type: 'integer',
        description: 'Contact-sheet grid rows; requires contactSheet and tileColumns.'
      },
      region: {
        type: 'object',
        additionalProperties: false,
        properties: {
          left: { type: 'number' },
          top: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' }
        },
        required: ['left', 'top', 'width', 'height'],
        description: 'Optional Board region to capture.'
      },
      elementIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional Board element IDs to capture.'
      },
      padding: {
        type: 'number',
        description: 'Board content padding; requires region or elementIds.'
      },
      scale: { type: 'number', description: 'Render scale from 0.1 to 4 for any Unit.' }
    },
    ['file', 'unitId', 'output']
  ),
  tool(
    'univer_print_pdf',
    'Print one explicit Sheet, Doc, Slide, or Board Unit from trunk or a worktree to a workspace PDF file. Base Units are not printable.',
    {
      file: fileField,
      output: { type: 'string', description: 'Workspace-relative or absolute .pdf output path.' },
      unitId: { type: 'string', description: 'Explicit Unit id from univer_status.' },
      worktreeId: { type: 'string', description: 'Optional worktree scope; omit to print trunk.' }
    },
    ['file', 'output', 'unitId']
  ),
  tool(
    'univer_api',
    'Look up the bundled, version-matched Univer Facade API. Use find when no relevant class or API label is known. Use show for a known class, type, or exact Class.member label. Find is case-insensitive; queries run independently and are never combined as AND.',
    {
      action: {
        type: 'string',
        enum: ['find', 'show'],
        description: 'find discovers unknown labels; show documents a known class, type, or Class.member label.'
      },
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'API-name keywords (find) or exact labels (show), e.g. FRange or FRange.setValue.'
      },
      unit: {
        type: 'string',
        enum: ['sheet', 'doc', 'slide', 'base', 'board'],
        description: 'Optional find-only Unit filter; shared APIs remain included.'
      },
      limit: { type: 'integer', description: 'Find-only maximum matches per query. Prefer 10 or fewer.' }
    },
    ['action', 'queries']
  ),
  tool(
    'univer_resources',
    'Discover, read, export, and cache bundled SVG resources. Use find before read or export; resource handles are stable within the bundled manifest.',
    {
      action: {
        type: 'string',
        enum: ['registries', 'find', 'read', 'export', 'clear-cache'],
        description: 'Resource-library operation.'
      },
      queries: { type: 'array', items: { type: 'string' }, description: 'Non-empty search terms for find.' },
      registries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional registry IDs that constrain find.'
      },
      limit: { type: 'integer', description: 'Optional positive total result limit for find.' },
      handle: { type: 'string', description: 'One resource handle for read.' },
      handles: { type: 'array', items: { type: 'string' }, description: 'Resource handles for export.' },
      output: {
        type: 'string',
        description: 'Workspace-relative or absolute export directory.'
      }
    },
    ['action']
  ),
  tool(
    'univer_open',
    'Open the live Univer Viewer for a .univer file in the default browser. Select an optional worktree and unit to review a draft. Returns the viewer URL.',
    {
      file: fileField,
      worktreeId: { type: 'string', description: 'Optional worktree to preview.' },
      unitId: { type: 'string', description: 'Optional Unit to focus inside the worktree.' },
      open: {
        type: 'boolean',
        description: 'Open the default browser. Defaults to true; pass false to only return the URL.'
      }
    },
    ['file']
  ),
  tool(
    'univer_gateway',
    'Inspect, start, or stop the bundled Univer Gateway process used by the viewer and content tools.',
    {
      action: {
        type: 'string',
        enum: ['status', 'ensure', 'stop'],
        description: 'Gateway lifecycle action.'
      }
    },
    ['action']
  )
]

async function callTool(name, args = {}) {
  const api = getService()

  if (name === 'univer_gateway') {
    if (args.action === 'ensure') return { ok: true, gateway: await api.ensureGateway() }
    if (args.action === 'stop') {
      await api.dispose()
      return { ok: true, stopped: true }
    }
    return { ok: true, status: await api.gatewayStatus() }
  }

  const workspace = await resolveWorkspace(args)
  const signal = AbortSignal.timeout(
    name === 'univer_screenshot' || name === 'univer_print_pdf' ? 240_000 : 180_000
  )

  if (name === 'univer_new') {
    const file = await resolveFile(workspace, args.file, { mustExist: false })
    return api.newFile({ workspace, file }, signal)
  }

  if (name === 'univer_status') {
    const file = await resolveFile(workspace, args.file)
    return api.status(
      {
        workspace,
        file,
        ...(args.worktreeId === undefined ? {} : { worktreeId: args.worktreeId }),
        ...(args.unitId === undefined ? {} : { unitId: args.unitId })
      },
      signal
    )
  }

  if (name === 'univer_worktree') {
    const file = await resolveFile(workspace, args.file)
    if (!['create', 'ready', 'reopen', 'merge', 'discard'].includes(args.action)) {
      throw new PortError('action must be create, ready, reopen, merge, or discard.', 'INVALID_REQUEST')
    }
    if (args.action === 'create') {
      const result = await api.worktree(
        { action: 'create', workspace, file, ...(args.name === undefined ? {} : { name: args.name }) },
        signal
      )
      return stripEnvelope(result)
    }
    if (typeof args.worktreeId !== 'string' || args.worktreeId.length === 0) {
      throw new PortError(`univer_worktree ${args.action} requires worktreeId.`, 'INVALID_REQUEST')
    }
    return stripEnvelope(
      await api.worktree(
        { action: args.action, workspace, file, worktreeId: args.worktreeId },
        signal
      )
    )
  }

  if (name === 'univer_unit') {
    const file = await resolveFile(workspace, args.file)
    if (args.action === 'create') {
      if (!['sheet', 'doc', 'slide', 'base', 'board'].includes(args.kind)) {
        throw new PortError('univer_unit create requires a valid kind.', 'INVALID_REQUEST')
      }
      if (typeof args.name !== 'string' || args.name.length === 0) {
        throw new PortError('univer_unit create requires a non-empty name.', 'INVALID_REQUEST')
      }
      return stripEnvelope(
        await api.unit(
          { action: 'create', workspace, file, worktreeId: args.worktreeId, kind: args.kind, name: args.name },
          signal
        )
      )
    }
    if (typeof args.unitId !== 'string' || args.unitId.length === 0) {
      throw new PortError('univer_unit remove requires unitId.', 'INVALID_REQUEST')
    }
    return stripEnvelope(
      await api.unit(
        { action: 'remove', workspace, file, worktreeId: args.worktreeId, unitId: args.unitId },
        signal
      )
    )
  }

  if (name === 'univer_import') {
    const file = await resolveFile(workspace, args.file)
    const source = await resolveFile(workspace, args.source, { univer: false })
    if (typeof args.name !== 'string' || args.name.trim().length === 0) {
      throw new PortError('univer_import requires a non-empty Unit name.', 'INVALID_REQUEST')
    }
    return stripEnvelope(
      await api.importUnitContent(
        {
          workspace,
          file,
          sourceWorkspace: workspace,
          source,
          worktreeId: args.worktreeId,
          name: args.name,
          ...(args.docType === undefined ? {} : { docType: args.docType })
        },
        signal
      )
    )
  }

  if (name === 'univer_inspect') {
    if (args.range !== undefined && args.elementIds !== undefined) {
      throw new PortError('Provide at most one of range or elementIds.', 'INSPECTION_INPUT_INVALID')
    }
    if (
      args.elementIds !== undefined &&
      (args.elementIds.length === 0 || args.elementIds.some((id) => String(id).length === 0))
    ) {
      throw new PortError(
        'elementIds must contain at least one non-empty Board element ID.',
        'INSPECTION_INPUT_INVALID'
      )
    }
    const file = await resolveFile(workspace, args.file)
    return api.inspectUnitContent(
      {
        workspace,
        file,
        unitId: args.unitId,
        ...(args.elementIds === undefined ? {} : { elementIds: args.elementIds }),
        ...(args.range === undefined ? {} : { range: args.range }),
        ...(args.worktreeId === undefined ? {} : { worktreeId: args.worktreeId })
      },
      signal
    )
  }

  if (name === 'univer_execute') {
    const file = await resolveFile(workspace, args.file)
    if ((args.code === undefined) === (args.codeFile === undefined)) {
      throw new PortError('Provide exactly one of code or codeFile.', 'INVALID_EXECUTION_SOURCE')
    }
    let code = args.code
    if (code === undefined) {
      const codePath = await resolveFile(workspace, args.codeFile, { univer: false })
      try {
        code = await readFile(codePath, 'utf8')
      } catch (error) {
        throw new PortError(
          `Cannot read codeFile ${JSON.stringify(args.codeFile)}.`,
          'CODE_FILE_READ_FAILED'
        )
      }
    }
    return api.executeUnitContent(
      { workspace, file, code, worktreeId: args.worktreeId, unitId: args.unitId },
      signal
    )
  }

  if (name === 'univer_export') {
    const file = await resolveFile(workspace, args.file)
    const output = await resolveFile(workspace, args.output, { mustExist: false, univer: false })
    return api.exportUnitContent(
      {
        workspace,
        file,
        outputWorkspace: workspace,
        output,
        unitId: args.unitId,
        ...(args.worktreeId === undefined ? {} : { worktreeId: args.worktreeId })
      },
      signal
    )
  }

  if (name === 'univer_lint') {
    const file = await resolveFile(workspace, args.file)
    return api.lintUnitLayout(
      {
        workspace,
        file,
        unitId: args.unitId,
        ...(args.worktreeId === undefined ? {} : { worktreeId: args.worktreeId }),
        ...(args.pages === undefined ? {} : { pages: normalizePages(args.pages) })
      },
      signal
    )
  }

  if (name === 'univer_compile_svg') {
    const file = await resolveFile(workspace, args.file)
    const source = await resolveFile(workspace, args.source, { univer: false })
    if (!Number.isSafeInteger(args.page) || args.page < 1) {
      throw new PortError('SVG target page must be a positive integer.', 'INVALID_REQUEST')
    }
    return api.compileSvg(
      {
        workspace,
        file,
        source,
        sourceWorkspace: workspace,
        worktreeId: args.worktreeId,
        unitId: args.unitId,
        page: args.page,
        ...(args.mode === undefined ? {} : { mode: args.mode })
      },
      signal
    )
  }

  if (name === 'univer_screenshot') {
    const file = await resolveFile(workspace, args.file)
    const output = await resolveFile(workspace, args.output, { mustExist: false, univer: false })
    const captured = await api.screenshotUnit(
      {
        workspace,
        file,
        unitId: args.unitId,
        outputWorkspace: workspace,
        output,
        ...(args.worktreeId === undefined ? {} : { worktreeId: args.worktreeId }),
        ...screenshotTarget(args)
      },
      signal
    )
    const images = captured.result.images
    return {
      ...captured,
      result: {
        ...captured.result,
        images: images.map(({ data: _data, ...meta }) => meta)
      },
      content: [
        text(
          JSON.stringify({
            ok: captured.ok,
            operation: captured.operation,
            file: captured.file,
            result: {
              ...captured.result,
              images: images.map(({ data: _data, ...meta }) => meta)
            }
          })
        ),
        ...images.map((image) => ({
          type: 'image',
          data: image.data,
          mimeType: image.mediaType
        }))
      ]
    }
  }

  if (name === 'univer_print_pdf') {
    const file = await resolveFile(workspace, args.file)
    const output = await resolveFile(workspace, args.output, { mustExist: false, univer: false })
    return api.printUnitPdf(
      {
        workspace,
        file,
        outputWorkspace: workspace,
        output,
        unitId: args.unitId,
        ...(args.worktreeId === undefined ? {} : { worktreeId: args.worktreeId })
      },
      signal
    )
  }

  if (name === 'univer_api') {
    if (!Array.isArray(args.queries) || args.queries.length === 0 || args.queries.some((q) => String(q).trim().length === 0)) {
      throw new PortError('univer_api requires at least one non-empty query.', 'INVALID_REQUEST')
    }
    if (args.action === 'show') {
      return api.apiReference({ action: 'show', queries: args.queries })
    }
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
      throw new PortError('univer_api limit must be a positive integer.', 'INVALID_REQUEST')
    }
    return api.apiReference({
      action: 'find',
      queries: args.queries,
      ...(args.unit === undefined ? {} : { unit: args.unit }),
      ...(args.limit === undefined ? {} : { limit: args.limit })
    })
  }

  if (name === 'univer_resources') {
    if (args.action === 'registries' || args.action === 'clear-cache') {
      return api.resources({ action: args.action }, signal)
    }
    if (args.action === 'find') {
      if (!Array.isArray(args.queries) || args.queries.length === 0 || args.queries.some((q) => String(q).trim().length === 0)) {
        throw new PortError('find requires at least one non-empty query.', 'RESOURCE_INPUT_INVALID')
      }
      if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1)) {
        throw new PortError('find limit must be a positive integer.', 'RESOURCE_INPUT_INVALID')
      }
      return api.resources(
        {
          action: 'find',
          queries: args.queries,
          ...(args.registries === undefined ? {} : { registries: args.registries }),
          ...(args.limit === undefined ? {} : { limit: args.limit })
        },
        signal
      )
    }
    if (args.action === 'read') {
      if (typeof args.handle !== 'string' || args.handle.trim().length === 0) {
        throw new PortError('read requires one non-empty handle.', 'RESOURCE_INPUT_INVALID')
      }
      return api.resources({ action: 'read', handle: args.handle }, signal)
    }
    if (args.action === 'export') {
      if (!Array.isArray(args.handles) || args.handles.length === 0 || args.handles.some((h) => String(h).trim().length === 0)) {
        throw new PortError('export requires at least one non-empty handle.', 'RESOURCE_INPUT_INVALID')
      }
      if (typeof args.output !== 'string' || args.output.trim().length === 0) {
        throw new PortError('export requires a non-empty output directory.', 'RESOURCE_INPUT_INVALID')
      }
      const output = await resolveFile(workspace, args.output, { mustExist: false, univer: false })
      return api.resources(
        { action: 'export', handles: args.handles, output, outputWorkspace: workspace },
        signal
      )
    }
    throw new PortError(
      'resources action must be registries, find, read, export, or clear-cache.',
      'RESOURCE_INPUT_INVALID'
    )
  }

  if (name === 'univer_open') {
    const file = await resolveFile(workspace, args.file)
    const state = await api.fileState({ workspace, file })
    let url = state.viewerUrl
    if (args.worktreeId !== undefined) {
      const worktree = state.worktrees.find((entry) => entry.worktreeId === args.worktreeId)
      if (worktree === undefined) {
        throw new PortError(`Worktree ${args.worktreeId} was not found.`, 'WORKTREE_NOT_FOUND')
      }
      url = worktree.worktreeUrl ?? worktree.openUrl ?? url
      if (args.unitId !== undefined) {
        const unit = worktree.units.find((entry) => entry.unitId === args.unitId)
        url =
          unit?.worktreeUrl ??
          `${url}${url.includes('?') ? '&' : '?'}unit=${encodeURIComponent(args.unitId)}`
      }
    }
    const absolute = new URL(url, state.gateway).toString()
    const shouldOpen = args.open !== false
    if (shouldOpen) openInBrowser(absolute)
    return { ok: true, url: absolute, gateway: state.gateway, opened: shouldOpen, worktrees: state.worktrees }
  }

  throw new PortError(`Unknown tool ${name}`, 'UNKNOWN_TOOL')
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name
  const args = request.params.arguments ?? {}
  try {
    const value = await callTool(name, args)
    if (Array.isArray(value?.content)) return value
    if (value?.content === undefined) {
      return { content: [text(JSON.stringify(value))] }
    }
    return value
  } catch (error) {
    return errorResult(error)
  }
})

let shuttingDown = false
async function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  try {
    await service?.dispose()
  } catch {
    // best effort
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)

const transport = new StdioServerTransport()
await server.connect(transport)
log(`ready (plugin root ${PLUGIN_ROOT}, workspace ${defaultWorkspace})`)

// Keep the process alive while the transport is open.
await new Promise(() => {})
