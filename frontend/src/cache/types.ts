/**
 * 版本化查询缓存的公共类型。
 *
 * 设计要点：
 * - 缓存按「策略」隔离，每条策略自带版本链；过期秒数 / 最大条目数 / 目标查询变化都会开出新版本。
 * - 快照（CacheSnapshot）是唯一的持久化形态，内存后端与持久化后端读写同一份结构，保证两个业务面命中结果一致。
 * - 坏版本用 corrupt 标记隔离，不参与任何命中；淘汰计划独立存证，不与缓存数据混在一起。
 */

/** 两个业务面：聚合计算、交互查询。二者只允许通过同一个版本化接口访问缓存。 */
export type CacheScope = 'aggregate' | 'query'

export type MissReason =
  | 'missing'
  | 'expired'
  | 'version-mismatch'
  | 'target-renamed'
  | 'disabled'
  | 'quarantined'
  | 'corrupt'

export type CachePolicy = {
  /** 策略编号，跨版本保持不变 */
  policyId: string
  /** 目标查询名称；改名后旧版本缓存不得被新策略接管 */
  targetQuery: string
  /** 缓存键规则说明，仅用于展示与审计 */
  keyRule: string
  /** 过期秒数，变化即产生新策略版本 */
  ttlSeconds: number
  refreshTrigger: string
  /** 命中率阈值，取值 0~1，仅驱动淘汰计划，不参与版本指纹 */
  hitRateThreshold: number
  /** 最大条目数，变化即产生新策略版本 */
  maxEntries: number
  evictionAlgorithm: string
  /** 停用后不再产生新条目，已有条目仍可回读 */
  enabled: boolean
}

export type CacheEntryRecord = {
  key: string
  value: unknown
  storedAt: number
  ttlSeconds: number
  /** 写入时所属的策略版本，旧版本条目永远不能命中新版本查询 */
  policyVersion: number
  /** 写入时的目标查询名，改名后据此拒绝接管 */
  targetQuery: string
  scope: CacheScope
  hits: number
  misses: number
  lastAccessAt: number
}

export type VersionStats = {
  hits: number
  misses: number
}

/** 版本内条目按业务面分表：聚合计算与交互查询同名键互不覆盖、互不串读。 */
export type ScopedEntryTable = Record<CacheScope, Record<string, CacheEntryRecord>>

export type CacheVersionData = {
  policyId: string
  version: number
  createdAt: number
  /** 版本被封存的时间；封存后只读，只供回读 */
  sealedAt?: number
  /** 坏版本隔离标记 */
  corrupt?: boolean
  quarantineReason?: string
  policy: CachePolicy
  stats: VersionStats
  entries: ScopedEntryTable
}

export type EvictionReason = 'hit-rate-below-threshold' | 'quota' | 'expired' | 'manual'

export type EvictionCandidate = {
  scope: CacheScope
  key: string
  hits: number
  misses: number
  hitRate: number
  ageSeconds: number
}

/** 淘汰计划的独立证据：哪怕只计划不执行，也要留痕。 */
export type EvictionEvidence = {
  evidenceId: string
  policyId: string
  policyVersion: number
  reason: EvictionReason
  plannedAt: number
  executedAt?: number
  /** 计划时刻策略整体命中率 */
  hitRate: number
  threshold: number
  candidates: EvictionCandidate[]
  evictedRefs: EvictionRef[]
  status: 'planned' | 'executed' | 'failed' | 'deferred'
  failure?: string
  plannedBy: string
}

export type AuditEvent = {
  at: number
  type: 'policy-registered' | 'version-bumped' | 'quarantine' | 'recovery' | 'external-commit' | 'migration'
  detail: string
  tabId: string
}

/** 快照是缓存的唯一完整形态，后端之间没有第二种数据结构。 */
export type CacheSnapshot = {
  format: 'iac-cache-snapshot/v1'
  /** 单调递增的提交序号，多标签页据此判定最后完整提交 */
  commitSeq: number
  committedAt: number
  lastWriterTab: string
  versions: CacheVersionData[]
  evidence: EvictionEvidence[]
  audit: AuditEvent[]
}

export type PersistedEnvelope = {
  format: 'iac-cache-envelope/v1'
  commitSeq: number
  committedAt: number
  lastWriterTab: string
  snapshot: CacheSnapshot
}

export type CacheHitResult =
  | { hit: true; value: unknown; entry: CacheEntryRecord; policyVersion: number }
  | { hit: false; reason: MissReason; policyVersion: number | null }

export type PutResult =
  | { ok: true; key: string; policyVersion: number; evictedRefs: EvictionRef[] }
  | { ok: false; reason: MissReason }

export type EvictionRef = { scope: CacheScope; key: string }

export type InvalidationNotice = {
  reason: 'external-commit' | 'external-corrupt-ignored' | 'quarantine' | 'recovery'
  commitSeq: number
  /** 各策略当前生效版本，便于其它页面核对 */
  activeVersions: Record<string, number>
  writerTab: string
  message: string
}

export type RecoveryReport = {
  recovered: boolean
  source: 'current' | 'tmp' | 'backup' | 'fresh'
  restoredCommitSeq: number
  restoredVersionByPolicy: Record<string, number>
  /** 备份点之后的提交全部丢失；损坏原文无法解析时条目数无法统计，需如实说明 */
  lostSince: number | null
  lostEntryCount: number | null
  detail: string
}

export type StaleCommitError = Error & { code: 'STALE_COMMIT'; expectedSeq: number; actualSeq: number }

/** 旧接口迁移输入：只允许携带键和值，旧条目对象本身不进入新版本。 */
export type LegacyEntry = { key: string; value: unknown }

export type LegacyEntryShim = LegacyEntry

export type MigrationResult = {
  migratedKeys: string[]
  skipped: { key: string; reason: MissReason }[]
}
