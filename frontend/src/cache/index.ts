/**
 * 版本化查询缓存统一出口。
 *
 * 聚合计算（aggregate）与交互查询（query）两个业务面只能通过本模块访问缓存：
 * 同一个引擎、同一份版本化快照、同一套提交/淘汰/恢复写法。
 */
export { CacheAccessSurface, createCacheService, getCacheService, resetCacheServiceForTesting } from './cache-service'
export type { CacheService } from './cache-service'
export { MemoryCacheBackend, PersistentCacheBackend, BackendWriteError, persistentKeyNames } from './backends'
export type { CacheBackend } from './backends'
export { definePolicy, policyFingerprint, validatePolicy } from './policy'
export { createMemoryShimStorage } from './runtime'
export { VersionedCacheEngine } from './versioned-cache'
export type { EngineOptions } from './versioned-cache'
export type {
  CacheEntryRecord,
  CacheHitResult,
  CachePolicy,
  CacheScope,
  CacheSnapshot,
  EvictionEvidence,
  InvalidationNotice,
  LegacyEntry,
  MigrationResult,
  MissReason,
  PutResult,
  RecoveryReport,
  StaleCommitError,
} from './types'
