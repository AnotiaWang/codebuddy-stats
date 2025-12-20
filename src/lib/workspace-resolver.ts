import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import { getIdeDataDir, getWorkspaceStorageDir } from './paths.js'

export interface WorkspaceMapping {
  hash: string
  folderUri: string
  displayPath: string
}

// 缓存已解析的 CodeBuddy Code 路径名
const codePathCache = new Map<string, string>()

/**
 * 从 folder URI 提取纯路径（用于计算 MD5）
 */
function extractPathFromUri(folderUri: string): string | null {
  // 处理本地文件路径: file:///path/to/folder
  if (folderUri.startsWith('file://')) {
    try {
      const url = new URL(folderUri)
      return decodeURIComponent(url.pathname)
    } catch {
      return decodeURIComponent(folderUri.replace('file://', ''))
    }
  }

  // 处理远程路径: vscode-remote://codebuddy-remote-ssh%2B.../path
  if (folderUri.startsWith('vscode-remote://')) {
    try {
      const url = new URL(folderUri)
      return decodeURIComponent(url.pathname)
    } catch {
      const match = folderUri.match(/vscode-remote:\/\/[^/]+(.+)$/)
      if (match?.[1]) {
        return decodeURIComponent(match[1])
      }
    }
  }

  return null
}

/**
 * 格式化路径用于显示（简化 home 目录）
 */
function formatDisplayPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return '~' + p.slice(home.length)
  }
  return p
}

/**
 * 从 folder URI 生成用于显示的友好路径
 */
function getDisplayPath(folderUri: string): string {
  // 本地路径
  if (folderUri.startsWith('file://')) {
    const p = extractPathFromUri(folderUri)
    if (p) {
      return formatDisplayPath(p)
    }
  }

  // 远程路径
  if (folderUri.startsWith('vscode-remote://')) {
    const p = extractPathFromUri(folderUri)
    if (p) {
      const hostMatch = folderUri.match(/vscode-remote:\/\/codebuddy-remote-ssh%2B([^/]+)/)
      if (hostMatch?.[1]) {
        let host = decodeURIComponent(hostMatch[1])
        host = host.replace(/_x([0-9a-fA-F]{2})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        host = host.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        if (host.includes('@')) {
          const parts = host.split('@')
          host = parts[parts.length - 1]?.split(':')[0] || host
        }
        if (host.length > 20) {
          host = host.slice(0, 17) + '...'
        }
        return `[${host}]${p}`
      }
      return `[remote]${p}`
    }
  }

  return folderUri
}

/**
 * 计算路径的 MD5 hash（CodeBuddyExtension 使用纯路径计算）
 */
function computePathHash(p: string): string {
  return crypto.createHash('md5').update(p).digest('hex')
}

/**
 * 从 CodeBuddyIDE 的 file-tree 数据中反推出 workspace hash -> 真实路径
 *
 * 背景：Remote SSH 场景下，server 侧 `workspaceStorage/<hash>/workspace.json` 可能不存在，
 * 但 CodeBuddyExtension 会把对话关联的文件路径写入 `file-tree.json`，可据此还原工作区根目录。
 */
async function loadWorkspaceMappingsFromIdeFileTree(): Promise<Map<string, WorkspaceMapping>> {
  const out = new Map<string, WorkspaceMapping>()
  const root = getIdeDataDir()

  async function pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  }

  function collectFilePaths(node: unknown, acc: string[], depth = 0): void {
    if (depth > 10) return
    if (typeof node === 'string') return

    if (Array.isArray(node)) {
      for (const item of node) collectFilePaths(item, acc, depth + 1)
      return
    }

    if (!node || typeof node !== 'object') return

    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === 'filePath' && typeof v === 'string' && v) {
        acc.push(v)
        continue
      }
      if (k === 'createdEntries' && Array.isArray(v)) {
        for (const e of v) {
          if (typeof e === 'string' && e) acc.push(e)
        }
        continue
      }
      collectFilePaths(v, acc, depth + 1)
    }
  }

  function resolveWorkspacePathFromFilePaths(hash: string, filePaths: string[]): string | null {
    for (const raw of filePaths) {
      const p = extractPathFromUri(raw) || (path.isAbsolute(raw) ? raw : null)
      if (!p) continue

      let cur = p
      for (let i = 0; i < 50; i++) {
        if (computePathHash(cur) === hash) return cur
        const parent = path.dirname(cur)
        if (parent === cur) break
        cur = parent
      }
    }

    return null
  }

  // 扫描 `Data/*/CodeBuddyIDE/*/file-tree/*/<convId>/file-tree.json`
  let level1: fsSync.Dirent[] = []
  try {
    level1 = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }

  for (const dirent of level1) {
    if (!dirent.isDirectory()) continue
    const codeBuddyIdeRoot = path.join(root, dirent.name, 'CodeBuddyIDE')
    if (!(await pathExists(codeBuddyIdeRoot))) continue

    // 兼容两种结构：
    // 1) CodeBuddyIDE/file-tree
    // 2) CodeBuddyIDE/<profile>/file-tree（当前主流）
    const profileDirs: string[] = []
    if (await pathExists(path.join(codeBuddyIdeRoot, 'file-tree'))) {
      profileDirs.push(codeBuddyIdeRoot)
    }

    let nested: fsSync.Dirent[] = []
    try {
      nested = await fs.readdir(codeBuddyIdeRoot, { withFileTypes: true })
    } catch {
      nested = []
    }

    for (const child of nested) {
      if (!child.isDirectory()) continue
      const profileDir = path.join(codeBuddyIdeRoot, child.name)
      if (await pathExists(path.join(profileDir, 'file-tree'))) {
        profileDirs.push(profileDir)
      }
    }

    for (const profileDir of profileDirs) {
      const fileTreeDir = path.join(profileDir, 'file-tree')

      let workspaces: fsSync.Dirent[] = []
      try {
        workspaces = await fs.readdir(fileTreeDir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const ws of workspaces) {
        if (!ws.isDirectory()) continue
        const workspaceHash = ws.name
        if (!/^[a-f0-9]{32}$/.test(workspaceHash)) continue
        if (out.has(workspaceHash)) continue

        const workspaceDir = path.join(fileTreeDir, workspaceHash)
        let convDirs: fsSync.Dirent[] = []
        try {
          convDirs = await fs.readdir(workspaceDir, { withFileTypes: true })
        } catch {
          continue
        }

        let resolved: string | null = null
        for (const conv of convDirs) {
          if (!conv.isDirectory()) continue
          const fileTreeJson = path.join(workspaceDir, conv.name, 'file-tree.json')
          try {
            const raw = await fs.readFile(fileTreeJson, 'utf8')
            const parsed = JSON.parse(raw) as unknown
            const paths: string[] = []
            collectFilePaths(parsed, paths)
            resolved = resolveWorkspacePathFromFilePaths(workspaceHash, paths)
            if (resolved) break
          } catch {
            // ignore
          }
        }

        if (!resolved) continue

        const folderUri = 'file://' + resolved
        out.set(workspaceHash, {
          hash: workspaceHash,
          folderUri,
          displayPath: getDisplayPath(folderUri),
        })
      }
    }
  }

  return out
}

/**
 * 从 CodeBuddyIDE 的 history/messages 中反推出 workspace hash -> 真实路径
 *
 * 场景：有些对话没有触发 file-tree 落盘，但 messages 里常包含 tool-result 的绝对路径。
 */
async function loadWorkspaceMappingsFromIdeHistory(): Promise<Map<string, WorkspaceMapping>> {
  const out = new Map<string, WorkspaceMapping>()
  const root = getIdeDataDir()

  async function pathExists(p: string): Promise<boolean> {
    try {
      await fs.access(p)
      return true
    } catch {
      return false
    }
  }

  async function readFileHeadUtf8(filePath: string, bytes = 64 * 1024): Promise<string> {
    const fh = await fs.open(filePath, 'r')
    try {
      const buf = Buffer.alloc(bytes)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      return buf.toString('utf8', 0, bytesRead)
    } finally {
      await fh.close()
    }
  }

  function extractCandidatePathsFromText(text: string): string[] {
    const set = new Set<string>()

    const uriRe = /(vscode-remote:\/\/[^\s"']+|file:\/\/[^\s"']+)/g
    for (const m of text.matchAll(uriRe)) {
      const v = m[1]
      if (v) set.add(v)
    }

    const absPathRe = /\/[A-Za-z0-9._~@%+=:,\-]+(?:\/[A-Za-z0-9._~@%+=:,\-]+)+/g
    for (const m of text.matchAll(absPathRe)) {
      const v = m[0]
      if (v) set.add(v)
    }

    return [...set]
  }

  function resolveWorkspacePathFromCandidates(hash: string, candidates: string[]): string | null {
    for (const raw of candidates) {
      const p = extractPathFromUri(raw) || (path.isAbsolute(raw) ? raw : null)
      if (!p) continue

      let cur = p
      for (let i = 0; i < 50; i++) {
        if (computePathHash(cur) === hash) return cur
        const parent = path.dirname(cur)
        if (parent === cur) break
        cur = parent
      }
    }

    return null
  }

  let level1: fsSync.Dirent[] = []
  try {
    level1 = await fs.readdir(root, { withFileTypes: true })
  } catch {
    return out
  }

  for (const dirent of level1) {
    if (!dirent.isDirectory()) continue
    const codeBuddyIdeRoot = path.join(root, dirent.name, 'CodeBuddyIDE')
    if (!(await pathExists(codeBuddyIdeRoot))) continue

    const profileDirs: string[] = []
    if (await pathExists(path.join(codeBuddyIdeRoot, 'history'))) {
      profileDirs.push(codeBuddyIdeRoot)
    }

    let nested: fsSync.Dirent[] = []
    try {
      nested = await fs.readdir(codeBuddyIdeRoot, { withFileTypes: true })
    } catch {
      nested = []
    }

    for (const child of nested) {
      if (!child.isDirectory()) continue
      const profileDir = path.join(codeBuddyIdeRoot, child.name)
      if (await pathExists(path.join(profileDir, 'history'))) {
        profileDirs.push(profileDir)
      }
    }

    for (const profileDir of profileDirs) {
      const historyDir = path.join(profileDir, 'history')

      let workspaces: fsSync.Dirent[] = []
      try {
        workspaces = await fs.readdir(historyDir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const ws of workspaces) {
        if (!ws.isDirectory()) continue
        const workspaceHash = ws.name
        if (!/^[a-f0-9]{32}$/.test(workspaceHash)) continue
        if (out.has(workspaceHash)) continue

        const workspaceDir = path.join(historyDir, workspaceHash)
        let convDirs: fsSync.Dirent[] = []
        try {
          convDirs = await fs.readdir(workspaceDir, { withFileTypes: true })
        } catch {
          continue
        }

        let resolved: string | null = null
        for (const conv of convDirs) {
          if (!conv.isDirectory()) continue
          const messagesDir = path.join(workspaceDir, conv.name, 'messages')
          if (!(await pathExists(messagesDir))) continue

          let msgFiles: fsSync.Dirent[] = []
          try {
            msgFiles = await fs.readdir(messagesDir, { withFileTypes: true })
          } catch {
            continue
          }

          let tried = 0
          for (const msg of msgFiles) {
            if (!msg.isFile() || !msg.name.endsWith('.json')) continue
            const msgPath = path.join(messagesDir, msg.name)
            tried += 1
            if (tried > 30) break

            try {
              const head = await readFileHeadUtf8(msgPath)
              const candidates = extractCandidatePathsFromText(head)
              resolved = resolveWorkspacePathFromCandidates(workspaceHash, candidates)
              if (resolved) break
            } catch {
              // ignore
            }
          }

          if (resolved) break
        }

        if (!resolved) continue

        const folderUri = 'file://' + resolved
        out.set(workspaceHash, {
          hash: workspaceHash,
          folderUri,
          displayPath: getDisplayPath(folderUri),
        })
      }
    }
  }

  return out
}

/**
 * 加载所有工作区映射
 */
export async function loadWorkspaceMappings(): Promise<Map<string, WorkspaceMapping>> {
  const mappings = new Map<string, WorkspaceMapping>()

  // 1) 尝试从客户端 workspaceStorage/workspace.json 解析
  const storageDir = getWorkspaceStorageDir()
  try {
    const entries = await fs.readdir(storageDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const workspaceJsonPath = path.join(storageDir, entry.name, 'workspace.json')
      try {
        const content = await fs.readFile(workspaceJsonPath, 'utf8')
        const data = JSON.parse(content) as { folder?: string }
        const folderUri = data.folder
        if (!folderUri) continue

        const extractedPath = extractPathFromUri(folderUri)
        if (!extractedPath) continue

        const hash = computePathHash(extractedPath)
        const displayPath = getDisplayPath(folderUri)
        mappings.set(hash, { hash, folderUri, displayPath })
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }

  // 2) Remote SSH 等场景的兜底：从 CodeBuddyIDE file-tree 反推
  try {
    const ideMappings = await loadWorkspaceMappingsFromIdeFileTree()
    for (const [hash, mapping] of ideMappings) {
      if (!mappings.has(hash)) mappings.set(hash, mapping)
    }
  } catch {
    // ignore
  }

  // 3) 进一步兜底：从 CodeBuddyIDE history/messages 反推（tool-result 常带绝对路径）
  try {
    const ideMappings = await loadWorkspaceMappingsFromIdeHistory()
    for (const [hash, mapping] of ideMappings) {
      if (!mappings.has(hash)) mappings.set(hash, mapping)
    }
  } catch {
    // ignore
  }

  return mappings
}

/**
 * 检查路径是否存在（同步版本，用于路径探测）
 */
function pathExistsSync(p: string): boolean {
  try {
    fsSync.accessSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 尝试将 CodeBuddy Code 的项目名（路径中 / 替换为 -）还原为真实路径
 * 使用回溯搜索，因为目录名本身可能包含 -
 *
 * 例如: "Users-foo-Documents-project-codebudy-cost-analyzer"
 *    -> "/Users/foo/Documents/project/codebudy-cost-analyzer"
 */
function tryResolveCodePath(name: string): string | null {
  // 检查缓存
  const cached = codePathCache.get(name)
  if (cached !== undefined) {
    return cached || null
  }

  const parts = name.split('-')
  if (parts.length < 2) {
    codePathCache.set(name, '')
    return null
  }

  // 回溯搜索：尝试不同的分割方式
  function backtrack(index: number, currentPath: string): string | null {
    if (index >= parts.length) {
      // 检查完整路径是否存在
      if (pathExistsSync(currentPath)) {
        return currentPath
      }
      return null
    }

    // 尝试从当前位置开始，合并不同数量的 parts
    for (let end = index; end < parts.length; end++) {
      const segment = parts.slice(index, end + 1).join('-')
      const newPath = currentPath ? `${currentPath}/${segment}` : `/${segment}`

      // 如果这不是最后一段，检查目录是否存在
      if (end < parts.length - 1) {
        if (pathExistsSync(newPath)) {
          const result = backtrack(end + 1, newPath)
          if (result) return result
        }
      } else {
        // 最后一段，检查完整路径
        if (pathExistsSync(newPath)) {
          return newPath
        }
      }
    }

    return null
  }

  const result = backtrack(0, '')
  codePathCache.set(name, result || '')
  return result
}

/**
 * 解析项目名称
 * - MD5 hash (32位十六进制): 从 IDE workspaceMappings 查找
 * - 路径格式 (包含 -): 尝试还原 CodeBuddy Code 的路径格式
 */
export function resolveProjectName(name: string, mappings?: Map<string, WorkspaceMapping>): string {
  // IDE source: MD5 hash
  if (mappings && /^[a-f0-9]{32}$/.test(name)) {
    const mapping = mappings.get(name)
    if (mapping) {
      return mapping.displayPath
    }
  }

  // Code source: 路径中 / 替换为 - 的格式
  // 特征：以大写字母开头（如 Users-、home-），包含 -
  if (/^[A-Za-z]/.test(name) && name.includes('-')) {
    const resolved = tryResolveCodePath(name)
    if (resolved) {
      return formatDisplayPath(resolved)
    }
  }

  return name
}
