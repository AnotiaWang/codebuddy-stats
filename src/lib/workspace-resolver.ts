import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import { getWorkspaceStorageDir } from './paths.js'

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
 * 加载所有工作区映射
 */
export async function loadWorkspaceMappings(): Promise<Map<string, WorkspaceMapping>> {
  const mappings = new Map<string, WorkspaceMapping>()
  const storageDir = getWorkspaceStorageDir()

  let entries: fsSync.Dirent[] = []
  try {
    entries = await fs.readdir(storageDir, { withFileTypes: true })
  } catch {
    return mappings
  }

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
      // 跳过无法读取的文件
    }
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
 * 例如: "Users-anoti-Documents-project-codebudy-cost-analyzer"
 *    -> "/Users/anoti/Documents/project/codebudy-cost-analyzer"
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
