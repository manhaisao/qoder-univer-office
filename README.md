# Univer Office for Qoder

将 [dsh-univer-office](https://github.com/dream-num/dsh-univer-office) 的办公能力移植为 Qoder 插件：16 个 `univer_*` MCP 工具 + 8 个 Univer 技能，覆盖电子表格、文档、幻灯片、多维表格（Base）和画板（Board）。

原项目是 DeepSeek Harness（DSH）的 Cordis 插件，自带 Web 客户端插槽、会话内预览卡片和审阅面板。Qoder 的插件扩展面是 **skills + hooks + MCP**，不能注入自定义聊天 UI，因此本移植复用了原包的 **Host 服务层**（`GatewayUniverService`）、Gateway、Viewer、Unit Content Worker 和技能，把工具层换成 MCP，把会话内预览换成**浏览器 Viewer**。

## 安装位置

```
C:\Users\<你>\.qoder-cn\plugins\cache\local\qoder-univer-office\0.4.0\
```

插件 ID：`qoder-univer-office@local`。安装脚本会写入：

- `~/.qoder-cn/plugins/installed_plugins_v2.json`
- `~/.qoder-cn/settings.json` → `enabledPlugins`

**安装或更新后重启 Qoder**，在 设置 → 插件 中确认 “Univer Office” 已启用。

## 能做什么

| 内容 | 能力 |
| --- | --- |
| Sheet | 单元格、公式、样式、表格、图表、透视表、筛选、数据验证、图片；导入/导出 `.xlsx` `.csv` `.tsv` |
| Doc | 段落、富文本、列表、表格、图片、图表、页眉页脚、分页；导入/导出 `.docx` |
| Slide | 页面、文字、形状、图片、表格、图表、SVG 排版、转场、布局检查；导入/导出 `.pptx` |
| Base | 数据表、字段、记录、视图、公式字段、筛选、排序、分组 |
| Board | 形状、文本、连接线、图片、原生图表、流程图、布局检查 |
| 组合 | 一个 `.univer` 文件可同时包含多种 Unit，公式可跨 Unit 引用 |

所有写入先进入隔离 **worktree**（草稿），可实时预览、继续修改、标记 `ready`、合入主线或丢弃。

## 快速开始

重启 Qoder 后，直接对 Agent 说：

```
帮我做一个工资计算表，包含员工、基本工资、奖金、扣款、应发工资和实发工资，自动汇总，最后导出 xlsx。
```

```
做一个 6 页的冒泡排序课件，讲清原理、逐轮比较、伪代码和复杂度，每页做布局检查。
```

```
把 D:\data\sales.xlsx 导入，清洗字段并生成按月汇总的图表，导出新的 xlsx。
```

```
做一个项目周报 docx，包含执行摘要、进展、风险表、下周计划和页眉页脚。
```

Agent 会自动加载 `univer` 技能并按流程调用工具。也可以显式说“使用 univer 技能”。

### 预览

让 Agent “打开预览”或调用 `univer_open`，会在默认浏览器打开 Viewer：

```
http://127.0.0.1:19090/univer-viewer/?file=<encoded-path>&worktree=<id>
```

Viewer 支持 View / Compare、worktree 切换、单元格/页面编辑等完整 Univer 能力。草稿审阅、合入或丢弃都通过 Viewer 和 `univer_worktree` 工具完成。

## 工具清单

| 工具 | 用途 |
| --- | --- |
| `univer_new` | 新建空 `.univer`（不覆盖已有文件） |
| `univer_status` | 查看 trunk Unit 与 worktree |
| `univer_worktree` | `create` / `ready` / `reopen` / `merge` / `discard` |
| `univer_unit` | 在草稿 worktree 中创建/删除 Unit |
| `univer_import` | 导入 xlsx/csv/tsv/docx/pptx |
| `univer_inspect` | 结构化回读内容（支持 range、Board elementIds） |
| `univer_execute` | 执行 Univer Facade JavaScript，写入草稿 |
| `univer_export` | 导出 xlsx/csv/tsv/docx/pptx |
| `univer_lint` | Slide 越界、溢出、文本重叠检查 |
| `univer_compile_svg` | 用真实字体度量把 SVG 编译到指定 Slide 页 |
| `univer_screenshot` | 渲染 PNG 并作为图片返回 |
| `univer_print_pdf` | 打印 PDF |
| `univer_api` | 查询版本匹配的 Facade API |
| `univer_resources` | 内置 SVG 资源库查找/读取/导出 |
| `univer_open` | 在浏览器打开 Viewer（可指定 worktree/unit） |
| `univer_gateway` | 查看/启动/停止 Gateway |

所有工具都接受可选的 `workspace`（绝对项目根目录）。不传时使用当前 Qoder 项目根目录；若报 `SESSION_SCOPE_DENIED`，显式传入项目路径。

Qoder 中工具可能显示为 `mcp__univer-office__univer_*`，与 `univer_*` 是同一组工具。

## 工作流（Agent 会自动遵循）

1. `univer_status` 确认已有 Unit / worktree；
2. 新建文件用 `univer_new`，再 `univer_worktree create`；
3. `univer_unit` 建 Unit 或 `univer_import` 导入；
4. 加载对应的 `univer-sheet` / `univer-doc` / `univer-slide` / `univer-base` / `univer-board` 技能；
5. `univer_execute` 写入，`univer_inspect` 回读，Slide 用 `univer_lint`，视觉检查用 `univer_screenshot`；
6. `univer_worktree ready` 标记待审；
7. 用户确认后再 `merge` 或 `discard`。

## 依赖与运行时

- Node.js ≥ 22.19（安装时使用当前 `node` 的绝对路径写入 `mcp.json`）
- 截图 / PDF / SVG 编译需要本机 Chrome、Chromium 或 Edge；也可设置 `UNIVER_RENDER_BROWSER` 指向浏览器可执行文件
- Gateway 默认监听 `127.0.0.1:19090`，被占用时自动递增端口
- 资源库缓存：`<插件目录>/.data/resources`
- `.univer` 数据保存在文件自身路径，不额外建库

### 环境变量（可写入 `mcp.json` 的 `env`）

| 变量 | 说明 |
| --- | --- |
| `UNIVER_WORKSPACE` | 默认工作区；不设时用 Qoder 项目根目录 |
| `UNIVER_GATEWAY_PORT` | Gateway 起始端口，默认 19090 |
| `UNIVER_RESOURCE_CACHE` | SVG 资源缓存目录 |
| `UNIVER_RENDER_BROWSER` | Chrome/Edge 可执行文件绝对路径 |
| `UNIVER_DEBUG` | `1` 时把诊断日志写到 stderr |

## 排障

**插件/工具没出现**
- 确认重启了 Qoder；设置 → 插件 里能看到 “Univer Office”；
- 检查 `~/.qoder-cn/settings.json` 中 `"qoder-univer-office@local": true`；
- 查看 Qoder 的 MCP 日志或临时设 `UNIVER_DEBUG=1` 后重启。

**工具报 `GATEWAY_UNAVAILABLE`**
- 用 `univer_gateway status/ensure` 检查；
- 端口被占用时会自动换端口；若启动失败，查看 stderr 日志；
- 本机需允许 `node` 启动子进程。

**截图 / PDF 失败**
- 安装 Chrome 或 Edge，或设置 `UNIVER_RENDER_BROWSER`；
- 首次截图可能较慢（浏览器冷启动）。

**模型看不到截图**
- 当前 Qoder 模型需要支持图片输入；不支持时仍会写入 PNG，可让 Agent 返回文件路径后手动查看。

**中文路径**
- Gateway 与 Viewer 使用 base64url 文件键，支持中文路径；若遇到问题，显式传绝对路径的 `workspace` 和 `file`。

## 与 DSH 原版的差异

| 能力 | DSH 原版 | Qoder 移植 |
| --- | --- | --- |
| Agent 工具 | DSH `defineTool` | MCP 工具（同名同参数） |
| 技能 | DSH Skill Registry | Qoder 插件 skills（同一份 SKILL.md） |
| 预览 | 会话内浮动窗口 + 审阅卡片 | `univer_open` 打开浏览器 Viewer |
| 文件树预览 | DSH 文件树入口 | 手动让 Agent 调 `univer_open` |
| 设置项 | DSH Settings | MCP `env`（端口、浏览器、缓存） |
| 会话隔离 | DSH session cwd | `workspace` 参数 + Qoder roots |
| 遥测 | best-effort | 关闭 |

## 开发

```powershell
cd D:\git\qoder-univer-office
npm install --legacy-peer-deps
node test/mcp-smoke.mjs        # MCP 端到端冒烟
node test/probe.mjs            # 服务层冒烟
node scripts/install.mjs       # 安装/更新到 Qoder
```

`vendor/` 下是 DSH 包的最小 shim（`HarnessError`、`defineTool` 等），只用于让发布包的模块图在 DSH 之外可加载；实际工具调用不经过它们。

## 许可

本移植沿用上游 `dsh-univer-office` 的 Apache-2.0 许可，见 [LICENSE](LICENSE)。Univer 及其 Pro 组件版权归 DreamNum Co., Ltd. 所有。
