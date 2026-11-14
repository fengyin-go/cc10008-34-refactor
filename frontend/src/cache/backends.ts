import {
  BrowserStorageBridge,
  cloneSnapshot,
  isEnvelope,
  serializeEnvelope,
  type MemoryShimStorage,
  type SimpleStorage,
} from './runtime'
import type { CacheSnapshot, PersistedEnvelope, RecoveryReport } from './types'

/**
 * 统一版本化存储接口：内存缓存与持久适配都实现这一个契约，
 * 上层引擎永远只面对「读整包快照 / 原子提交整包快照」，没有两套写法。
 */
export interface CacheBackend {
  readonly kind: 'memory' | 'persistent'
  load(): CacheSnapshot | null
  save(snapshot: CacheSnapshot, writerTab: string): void
  /** 只看当前提交序号，用于乐观并发检查；不触发恢复逻辑、不重置恢复报告 */
  peekSeq(): number | null
  /** 外部完整提交（其它标签页）通知；corrupt=true 表示对端写来无法解析的坏值，应忽略并广播失效提示 */
  subscribe(listener: (snapshot: CacheSnapshot, raw: string | null, corrupt: boolean) => void): () => void
  /** 最近一次损坏恢复报告，无恢复则为 null */
  lastRecovery(): RecoveryReport | null
}

export class BackendWriteError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BackendWriteError'
  }
}

function emptySnapshot(): CacheSnapshot {
  return {
    format: 'iac-cache-snapshot/v1',
    commitSeq: 0,
    committedAt: 0,
    lastWriterTab: '',
    versions: [],
    evidence: [],
    audit: [],
  }
}

/**
 * 内存后端：保存的是结构化克隆副本，外部拿到的也是副本。
 * 这样旧内存对象不可能被直接挂进新版本——引擎提交的永远是快照副本。
 */
export class MemoryCacheBackend implements CacheBackend {
  readonly kind = 'memory' as const
  private snapshot: CacheSnapshot | null = null
  private listeners = new Set<(snapshot: CacheSnapshot, raw: string | null, corrupt: boolean) => void>()

  load(): CacheSnapshot | null {
    return this.snapshot ? cloneSnapshot(this.snapshot) : null
  }

  peekSeq(): number | null {
    return this.snapshot ? this.snapshot.commitSeq : null
  }

  save(snapshot: CacheSnapshot, _writerTab?: string): void {
    this.snapshot = cloneSnapshot(snapshot)
    for (const listener of [...this.listeners]) {
      listener(cloneSnapshot(this.snapshot), null, false)
    }
  }

  subscribe(listener: (snapshot: CacheSnapshot, raw: string | null, corrupt: boolean) => void): () => void {
    const wrapped = (snapshot: CacheSnapshot, raw: string | null, corrupt: boolean) => listener(snapshot, raw, corrupt)
    this.listeners.add(wrapped)
    return () => this.listeners.delete(wrapped)
  }

  lastRecovery(): RecoveryReport | null {
    return null
  }
}

type PersistentKeys = {
  current: string
  tmp: string
  backup: string
}

/**
 * 持久化后端：当前信封 / 临时信封 / 备份信封三键轮换。
 * 提交顺序固定为 写 tmp → 备份旧 current → current 落新值 → 清 tmp，
 * 任何一步中断都能从 tmp 或 backup 恢复到「上一次完整快照」，且不会把半截 JSON 当数据用。
 */
export class PersistentCacheBackend implements CacheBackend {
  readonly kind = 'persistent' as const
  private readonly bridge: BrowserStorageBridge
  private readonly keys: PersistentKeys
  private recovery: RecoveryReport | null = null
  private failNextSave = 0
  private crashAfterTmp = false

  constructor(namespace = 'interactive-analytics-lab', storage?: SimpleStorage) {
    this.bridge = new BrowserStorageBridge(storage)
    this.keys = {
      current: `${namespace}:cache:current`,
      tmp: `${namespace}:cache:tmp`,
      backup: `${namespace}:cache:backup`,
    }
  }

  /** 测试专用：让接下来 n 次 save 在持久写入环节抛错（淘汰失败不能清空缓存的验证用）。 */
  failSaves(times = 1): void {
    this.failNextSave += times
  }

  /**
   * 测试专用：下一次 save 在 tmp 落盘后、current 更新前「崩溃」。
   * tmp 保留完整信封，current 被写成坏值，用于验证重启后的 tmp 提升恢复。
   */
  crashAfterTmpOnce(): void {
    this.crashAfterTmp = true
  }

  lastRecovery(): RecoveryReport | null {
    return this.recovery
  }

  peekSeq(): number | null {
    const current = this.readKey(this.keys.current)
    return current ? current.commitSeq : null
  }

  private readKey(key: string): PersistedEnvelope | null {
    const raw = this.bridge.storage.getItem(key)
    if (raw === null) {
      return null
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isEnvelope(parsed)) {
        return null
      }
      return parsed
    } catch {
      return null
    }
  }

  private rawKey(key: string): string | null {
    return this.bridge.storage.getItem(key)
  }

  load(): CacheSnapshot | null {
    this.recovery = null
    const current = this.readKey(this.keys.current)
    if (current) {
      return cloneSnapshot(current.snapshot)
    }

    // current 缺失或损坏：按 tmp（最近一次完整提交可能落在这里）→ backup 顺序抢救。
    const currentRaw = this.rawKey(this.keys.current)
    const currentWasCorrupt = currentRaw !== null
    const tmpRaw = this.rawKey(this.keys.tmp)
    const tmp = tmpRaw === null ? null : this.readKey(this.keys.tmp)
    if (tmp) {
      this.promote(tmp)
      this.recovery = this.buildReport('tmp', tmp, currentWasCorrupt)
      return cloneSnapshot(tmp.snapshot)
    }

    const backupRaw = this.rawKey(this.keys.backup)
    const backup = backupRaw === null ? null : this.readKey(this.keys.backup)
    if (backup) {
      this.promote(backup)
      this.recovery = this.buildReport('backup', backup, currentWasCorrupt)
      return cloneSnapshot(backup.snapshot)
    }

    // 三处都不可用：损坏的 current 可能还残留在存储里，如实记录无法统计的丢失范围。
    const corruptRaw = this.rawKey(this.keys.current) ?? tmpRaw ?? backupRaw
    if (corruptRaw !== null) {
      this.bridge.storage.removeItem(this.keys.current)
      this.bridge.storage.removeItem(this.keys.tmp)
      this.bridge.storage.removeItem(this.keys.backup)
      this.recovery = {
        recovered: false,
        source: 'fresh',
        restoredCommitSeq: 0,
        restoredVersionByPolicy: {},
        lostSince: null,
        lostEntryCount: null,
        detail: '当前信封、临时信封与备份信封均无法解析，缓存已重建为空快照；损坏原文不可解析，丢失条目数无法统计。',
      }
    }
    return null
  }

  private promote(envelope: PersistedEnvelope): void {
    this.bridge.storage.setItem(this.keys.current, serializeEnvelope(envelope))
    this.bridge.storage.removeItem(this.keys.tmp)
  }

  private buildReport(source: 'tmp' | 'backup', envelope: PersistedEnvelope, currentWasCorrupt: boolean): RecoveryReport {
    const restoredVersionByPolicy: Record<string, number> = {}
    let survivingEntryCount = 0
    for (const version of envelope.snapshot.versions) {
      restoredVersionByPolicy[version.policyId] = version.version
      const tables = version.entries as unknown as Record<string, Record<string, unknown>>
      survivingEntryCount += Object.values(tables).reduce((sum, table) => sum + Object.keys(table ?? {}).length, 0)
    }
    const sourceName = source === 'tmp' ? '临时信封' : '备份信封'
    const cause = currentWasCorrupt ? '当前信封损坏' : '当前信封缺失'
    const detail =
      `${cause}，已从${sourceName}恢复到提交序号 ${envelope.commitSeq} 的完整快照。` +
      ` 该序号之后的提交全部丢失；恢复快照内现存 ${survivingEntryCount} 个条目，损坏点之后新增条目的丢失数量无法统计。`
    return {
      recovered: true,
      source,
      restoredCommitSeq: envelope.commitSeq,
      restoredVersionByPolicy,
      lostSince: envelope.committedAt,
      // 损坏点之后丢了多少条无法从幸存快照推算，故保持 null，并在 detail 中如实说明。
      lostEntryCount: null,
      detail,
    }
  }

  save(snapshot: CacheSnapshot, writerTab: string): void {
    if (this.failNextSave > 0) {
      this.failNextSave -= 1
      throw new BackendWriteError('持久化写入被模拟故障中断：本次提交未生效，内存视图保持原完整快照')
    }
    const envelope: PersistedEnvelope = {
      format: 'iac-cache-envelope/v1',
      commitSeq: snapshot.commitSeq,
      committedAt: snapshot.committedAt,
      lastWriterTab: writerTab,
      snapshot: cloneSnapshot(snapshot),
    }
    // 先落 tmp：若在写 current 前崩溃，重启后 load() 会从 tmp 提升出完整快照。
    this.bridge.storage.setItem(this.keys.tmp, serializeEnvelope(envelope))
    if (this.crashAfterTmp) {
      this.crashAfterTmp = false
      const shim = this.bridge.storage as MemoryShimStorage
      shim.corruptRaw(this.keys.current, '{崩溃在 current 写入前的半截内容')
      throw new BackendWriteError('模拟进程在 tmp 落盘后、current 更新前崩溃')
    }
    const previous = this.readKey(this.keys.current)
    if (previous) {
      this.bridge.storage.setItem(this.keys.backup, serializeEnvelope(previous))
    }
    this.bridge.storage.setItem(this.keys.current, serializeEnvelope(envelope))
    this.bridge.storage.removeItem(this.keys.tmp)
  }

  subscribe(listener: (snapshot: CacheSnapshot, raw: string | null, corrupt: boolean) => void): () => void {
    return this.bridge.onChange((event) => {
      if (event.key !== this.keys.current) {
        return
      }
      if (event.newValue === null) {
        listener(emptySnapshot(), null, false)
        return
      }
      try {
        const parsed: unknown = JSON.parse(event.newValue)
        if (isEnvelope(parsed)) {
          listener(cloneSnapshot(parsed.snapshot), event.newValue, false)
          return
        }
        // 结构非法：标记 corrupt，引擎保留手上的完整快照并广播失效提示。
        listener(emptySnapshot(), event.newValue, true)
      } catch {
        // JSON 无法解析：同上，绝不把半截数据当快照采用。
        listener(emptySnapshot(), event.newValue, true)
      }
    })
  }
}

export function persistentKeyNames(namespace = 'interactive-analytics-lab'): PersistentKeys {
  return {
    current: `${namespace}:cache:current`,
    tmp: `${namespace}:cache:tmp`,
    backup: `${namespace}:cache:backup`,
  }
}
