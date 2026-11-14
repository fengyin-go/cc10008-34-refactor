import { MemoryCacheBackend, PersistentCacheBackend, type CacheBackend } from './backends'
import { definePolicy } from './policy'
import type { SimpleStorage } from './runtime'
import { VersionedCacheEngine } from './versioned-cache'
import type {
  CacheHitResult,
  CachePolicy,
  CacheScope,
  EvictionEvidence,
  InvalidationNotice,
  LegacyEntry,
  MigrationResult,
  PutResult,
} from './types'

/**
 * 业务面门面：聚合计算与交互查询不再各写一套缓存访问，
 * 全部经由这里转到同一个 VersionedCacheEngine 的同一份版本化快照。
 */
export class CacheAccessSurface {
  constructor(
    readonly scope: CacheScope,
    private readonly engine: VersionedCacheEngine,
  ) {}

  registerPolicy(policy: Omit<CachePolicy, 'enabled'> & { enabled?: boolean }): { policyId: string; version: number; bumped: boolean } {
    return this.engine.registerPolicy(definePolicy(policy))
  }

  updatePolicy(policyId: string, patch: Partial<Omit<CachePolicy, 'policyId' | 'enabled'>>): { version: number; bumped: boolean } {
    return this.engine.updatePolicy(policyId, patch)
  }

  setEnabled(policyId: string, enabled: boolean): void {
    this.engine.setEnabled(policyId, enabled)
  }

  get(policyId: string, key: string): CacheHitResult {
    return this.engine.get(this.scope, policyId, key)
  }

  put(policyId: string, key: string, value: unknown): PutResult {
    return this.engine.put(this.scope, policyId, key, value)
  }

  readArchived(policyId: string, version: number, key: string): CacheHitResult {
    return this.engine.readArchived(this.scope, policyId, version, key)
  }

  planEviction(policyId: string, options?: { reason?: EvictionEvidence['reason']; execute?: boolean }): EvictionEvidence {
    return this.engine.planEviction(policyId, options)
  }

  migrateLegacyValues(policyId: string, legacyEntries: LegacyEntry[]): MigrationResult {
    return this.engine.migrateLegacyValues(this.scope, policyId, legacyEntries)
  }
}

export type CacheService = {
  engine: VersionedCacheEngine
  /** 聚合计算业务面 */
  aggregate: CacheAccessSurface
  /** 交互查询业务面 */
  query: CacheAccessSurface
  onInvalidate(listener: (notice: InvalidationNotice) => void): () => void
  dispose(): void
}

function hasLocalStorage(): boolean {
  return (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { localStorage?: SimpleStorage }).localStorage?.getItem === 'function'
  )
}

/**
 * 装配缓存服务：默认浏览器走持久化后端（localStorage 三键原子轮换），
 * 无 localStorage 环境自动退到内存后端；测试可显式注入后端。
 */
export function createCacheService(backend?: CacheBackend): CacheService {
  const resolved = backend ?? (hasLocalStorage() ? new PersistentCacheBackend() : new MemoryCacheBackend())
  const engine = new VersionedCacheEngine({ backend: resolved })
  return {
    engine,
    aggregate: new CacheAccessSurface('aggregate', engine),
    query: new CacheAccessSurface('query', engine),
    onInvalidate: (listener) => engine.onInvalidate(listener),
    dispose: () => engine.dispose(),
  }
}

let sharedService: CacheService | null = null

/** 两个业务面共享的单例：进程内只有一份版本化缓存。 */
export function getCacheService(): CacheService {
  if (!sharedService) {
    sharedService = createCacheService()
  }
  return sharedService
}

/** 测试专用：重置单例（例如换一个假存储重新装配）。 */
export function resetCacheServiceForTesting(backend?: CacheBackend): CacheService {
  sharedService?.dispose()
  sharedService = createCacheService(backend ?? new MemoryCacheBackend())
  return sharedService
}
