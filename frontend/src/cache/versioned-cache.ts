import type { CacheBackend } from './backends'
import { policyFingerprint, validatePolicy } from './policy'
import { cloneSnapshot, createTabId } from './runtime'
import type {
  AuditEvent,
  CacheEntryRecord,
  CacheHitResult,
  CachePolicy,
  CacheScope,
  CacheSnapshot,
  CacheVersionData,
  EvictionCandidate,
  EvictionEvidence,
  EvictionReason,
  EvictionRef,
  InvalidationNotice,
  LegacyEntry,
  MigrationResult,
  MissReason,
  PutResult,
  RecoveryReport,
  ScopedEntryTable,
  StaleCommitError,
} from './types'

export type EngineOptions = {
  backend: CacheBackend
  now?: () => number
  tabId?: string
}

const SCOPES: CacheScope[] = ['aggregate', 'query']

function emptyEntryTable(): ScopedEntryTable {
  return { aggregate: {}, query: {} }
}

function staleCommitError(expectedSeq: number, actualSeq: number): StaleCommitError {
  const error = new Error(
    `检测到其它标签页的更新提交（本地基于序号 ${expectedSeq}，远端已是 ${actualSeq}），本次写入已拒绝并已同步远端版本`,
  ) as StaleCommitError
  error.code = 'STALE_COMMIT'
  error.expectedSeq = expectedSeq
  error.actualSeq = actualSeq
  return error
}

/**
 * 版本化缓存引擎：聚合计算与交互查询两个业务面唯一的缓存入口。
 *
 * 不变量：
 * 1. 任何状态变化都走同一条提交流程（克隆整包快照 → 变更 → 后端原子落盘 → 整体替换内存指针），
 *    不存在「内存先换、持久后补」的中间态，切换期间两个业务面读到的永远是同一个完整版本。
 * 2. 提交流程内先持久化成功才替换内存引用，后端失败时旧快照原封不动，淘汰失败不可能清空缓存。
 * 3. 坏版本只做隔离标记，不删除数据；旧版本只读回读，永不参与新查询命中。
 * 4. 条目在版本内按业务面分表，聚合与查询同名键互不覆盖。
 */
export class VersionedCacheEngine {
  private readonly backend: CacheBackend
  private readonly clock: () => number
  readonly tabId: string
  private snapshot: CacheSnapshot
  private readonly invalidationListeners = new Set<(notice: InvalidationNotice) => void>()
  private readonly unsubscribeBackend: () => void
  private paused = false
  private queuedRemote: CacheSnapshot | null = null
  private evidenceSeq = 0

  constructor(options: EngineOptions) {
    this.backend = options.backend
    this.clock = options.now ?? (() => Date.now())
    this.tabId = options.tabId ?? createTabId()
    const loaded = this.backend.load()
    this.snapshot = loaded ?? {
      format: 'iac-cache-snapshot/v1',
      commitSeq: 0,
      committedAt: 0,
      lastWriterTab: this.tabId,
      versions: [],
      evidence: [],
      audit: [],
    }
    this.normalizeSnapshot(this.snapshot)
    this.unsubscribeBackend = this.backend.subscribe((remote, raw, corrupt) => this.handleRemoteCommit(remote, raw, corrupt))
  }

  dispose(): void {
    this.unsubscribeBackend()
    this.invalidationListeners.clear()
  }

  // ---------------------------------------------------------------- 条目分表工具

  /** 兼容历史快照：旧结构 entries 若没有分表则补空表，绝不把旧对象直接当新条目。 */
  private normalizeSnapshot(snapshot: CacheSnapshot): void {
    for (const version of snapshot.versions) {
      if (!version.entries || typeof version.entries.aggregate !== 'object') {
        version.entries = emptyEntryTable()
      }
      for (const scope of SCOPES) {
        if (!version.entries[scope]) {
          version.entries[scope] = {}
        }
      }
    }
  }

  private readEntry(version: CacheVersionData, scope: CacheScope, key: string): CacheEntryRecord | undefined {
    return version.entries[scope]?.[key]
  }

  private allEntries(version: CacheVersionData): CacheEntryRecord[] {
    return SCOPES.flatMap((scope) => Object.values(version.entries[scope]))
  }

  private totalEntryCount(version: CacheVersionData): number {
    return SCOPES.reduce((sum, scope) => sum + Object.keys(version.entries[scope]).length, 0)
  }

  // ---------------------------------------------------------------- 内部工具

  private activeIndex(policyId: string): number {
    let found = -1
    for (let i = 0; i < this.snapshot.versions.length; i += 1) {
      const version = this.snapshot.versions[i]
      if (version.policyId === policyId && (found === -1 || version.version > this.snapshot.versions[found].version)) {
        found = i
      }
    }
    return found
  }

  private requireActive(policyId: string): CacheVersionData {
    const index = this.activeIndex(policyId)
    if (index === -1) {
      throw new Error(`缓存策略 ${policyId} 尚未登记，无法访问缓存`)
    }
    return this.snapshot.versions[index]
  }

  private findVersion(policyId: string, version: number): CacheVersionData | null {
    return this.snapshot.versions.find((item) => item.policyId === policyId && item.version === version) ?? null
  }

  private appendAudit(draft: CacheSnapshot, type: AuditEvent['type'], detail: string): void {
    draft.audit.push({ at: this.clock(), type, detail, tabId: this.tabId })
  }

  /**
   * 唯一提交入口。draft 基于当前快照克隆，mutate 只允许操作 draft；
   * 后端写入失败直接抛错，内存快照保持上一次完整状态。
   */
  private commit(mutate: (draft: CacheSnapshot) => void, audit?: { type: AuditEvent['type']; detail: string }): CacheSnapshot {
    const baseSeq = this.snapshot.commitSeq
    const draft = cloneSnapshot(this.snapshot)
    this.normalizeSnapshot(draft)
    mutate(draft)
    if (audit) {
      this.appendAudit(draft, audit.type, audit.detail)
    }
    draft.commitSeq = baseSeq + 1
    draft.committedAt = this.clock()
    draft.lastWriterTab = this.tabId

    // 乐观并发：落盘前只核对后端最新序号，多标签页同时写入时拒绝过期基线。
    const remoteSeq = this.backend.peekSeq()
    if (remoteSeq !== null && remoteSeq !== baseSeq) {
      const persisted = this.backend.load()
      if (persisted) {
        this.adoptRemote(persisted, 'external-commit')
      }
      throw staleCommitError(baseSeq, remoteSeq)
    }

    this.backend.save(draft, this.tabId)
    this.snapshot = draft
    return draft
  }

  private handleRemoteCommit(remote: CacheSnapshot, raw: string | null, corrupt: boolean): void {
    if (this.paused) {
      // 暂停期间只保留最后一个完整提交，恢复后一次到位，不展示任何中间/过期值。
      if (!corrupt) {
        this.queuedRemote = remote
      }
      return
    }
    if (corrupt || (raw !== null && remote.format !== 'iac-cache-snapshot/v1')) {
      this.emit({
        reason: 'external-corrupt-ignored',
        commitSeq: this.snapshot.commitSeq,
        activeVersions: this.activeVersionMap(),
        writerTab: this.tabId,
        message: '其它标签页写入了无法解析的缓存数据，已忽略，本页面继续使用当前完整快照',
      })
      return
    }
    this.adoptRemote(remote, 'external-commit')
  }

  private adoptRemote(remote: CacheSnapshot, reason: InvalidationNotice['reason']): void {
    if (remote.commitSeq <= this.snapshot.commitSeq) {
      return
    }
    const writer = remote.lastWriterTab
    const incoming = cloneSnapshot(remote)
    this.normalizeSnapshot(incoming)
    this.snapshot = incoming
    this.emit({
      reason,
      commitSeq: remote.commitSeq,
      activeVersions: this.activeVersionMap(),
      writerTab: writer,
      message: `缓存已被标签页 ${writer} 的完整提交更新，本页面持有的旧版本全部失效`,
    })
  }

  private activeVersionMap(): Record<string, number> {
    const map: Record<string, number> = {}
    for (const version of this.snapshot.versions) {
      if (map[version.policyId] === undefined || version.version > map[version.policyId]) {
        map[version.policyId] = version.version
      }
    }
    return map
  }

  private emit(notice: InvalidationNotice): void {
    for (const listener of [...this.invalidationListeners]) {
      listener(notice)
    }
  }

  private entryHitRate(entry: CacheEntryRecord): number {
    const total = entry.hits + entry.misses
    return total === 0 ? 0 : entry.hits / total
  }

  private versionHitRate(version: CacheVersionData): number {
    const total = version.stats.hits + version.stats.misses
    return total === 0 ? 0 : version.stats.hits / total
  }

  private isExpired(entry: CacheEntryRecord, now: number): boolean {
    return now - entry.storedAt >= entry.ttlSeconds * 1000
  }

  private cloneValue<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T
  }

  // ---------------------------------------------------------------- 策略与版本

  /**
   * 登记策略或对齐策略版本。
   * 新策略建 v1；已存在且指纹（目标查询/过期秒数/最大条目数）变化时封存旧版本并开出新版本。
   */
  registerPolicy(policy: CachePolicy): { policyId: string; version: number; bumped: boolean } {
    validatePolicy(policy)
    const index = this.activeIndex(policy.policyId)
    if (index === -1) {
      this.commit(
        (draft) => {
          draft.versions.push({
            policyId: policy.policyId,
            version: 1,
            createdAt: this.clock(),
            policy: this.cloneValue(policy),
            stats: { hits: 0, misses: 0 },
            entries: emptyEntryTable(),
          })
        },
        { type: 'policy-registered', detail: `登记缓存策略 ${policy.policyId}（v1）` },
      )
      return { policyId: policy.policyId, version: 1, bumped: false }
    }
    return this.bumpIfNeeded(policy)
  }

  /**
   * 修改策略。指纹字段变化 → 新版本；命中率阈值等非指纹字段变化 → 当前版本原地更新，不产生新版本。
   */
  updatePolicy(policyId: string, patch: Partial<Omit<CachePolicy, 'policyId' | 'enabled'>>): { version: number; bumped: boolean } {
    const current = this.requireActive(policyId)
    const merged: CachePolicy = { ...current.policy, ...patch, policyId, enabled: current.policy.enabled }
    validatePolicy(merged)
    if (policyFingerprint(merged) === policyFingerprint(current.policy)) {
      this.commit((draft) => {
        const target = draft.versions[this.activeIndex(policyId)]
        target.policy = this.cloneValue(merged)
      })
      return { version: current.version, bumped: false }
    }
    return this.bumpIfNeeded(merged)
  }

  private bumpIfNeeded(nextPolicy: CachePolicy): { policyId: string; version: number; bumped: boolean } {
    const current = this.requireActive(nextPolicy.policyId)
    if (policyFingerprint(nextPolicy) === policyFingerprint(current.policy)) {
      return { policyId: nextPolicy.policyId, version: current.version, bumped: false }
    }
    const newVersion = current.version + 1
    this.commit(
      (draft) => {
        const target = draft.versions[this.activeIndex(nextPolicy.policyId)]
        target.sealedAt = this.clock()
        draft.versions.push({
          policyId: nextPolicy.policyId,
          version: newVersion,
          createdAt: this.clock(),
          policy: this.cloneValue(nextPolicy),
          stats: { hits: 0, misses: 0 },
          entries: emptyEntryTable(),
        })
      },
      {
        type: 'version-bumped',
        detail: `策略 ${nextPolicy.policyId} 指纹变化（目标查询/过期秒数/最大条目数），封存 v${current.version} 并启用 v${newVersion}`,
      },
    )
    return { policyId: nextPolicy.policyId, version: newVersion, bumped: true }
  }

  /** 停用 / 启用策略：停用后 put 一律拒绝，已有条目仍可回读。 */
  setEnabled(policyId: string, enabled: boolean): void {
    this.requireActive(policyId)
    this.commit((draft) => {
      const target = draft.versions[this.activeIndex(policyId)]
      target.policy.enabled = enabled
    })
  }

  // ---------------------------------------------------------------- 读路径（两个业务面共用）

  get(scope: CacheScope, policyId: string, key: string): CacheHitResult {
    const version = this.requireActive(policyId)
    if (version.corrupt) {
      return { hit: false, reason: 'quarantined', policyVersion: version.version }
    }
    const entry = this.readEntry(version, scope, key)
    if (!entry) {
      return this.recordMiss(scope, policyId, key, 'missing')
    }
    if (entry.policyVersion !== version.version || entry.targetQuery !== version.policy.targetQuery) {
      // 双保险：即便旧对象被错误塞入，版本号/目标查询对不上也绝不命中。
      return this.recordMiss(
        scope,
        policyId,
        key,
        entry.targetQuery !== version.policy.targetQuery ? 'target-renamed' : 'version-mismatch',
      )
    }
    if (this.isExpired(entry, this.clock())) {
      return this.recordMiss(scope, policyId, key, 'expired')
    }
    this.commit((draft) => {
      const target = draft.versions[this.activeIndex(policyId)]
      const live = target.entries[scope][key]
      live.hits += 1
      live.lastAccessAt = this.clock()
      target.stats.hits += 1
    })
    // 提交后重新从最新快照取值，绝不把提交前的内存对象直接返回给业务面。
    const fresh = this.requireActive(policyId).entries[scope][key]
    return {
      hit: true,
      value: this.cloneValue(fresh.value),
      entry: { ...fresh, value: this.cloneValue(fresh.value) },
      policyVersion: version.version,
    }
  }

  private recordMiss(scope: CacheScope, policyId: string, key: string, reason: MissReason): CacheHitResult {
    const version = this.requireActive(policyId)
    this.commit((draft) => {
      const target = draft.versions[this.activeIndex(policyId)]
      target.stats.misses += 1
      const entry = target.entries[scope][key]
      if (entry) {
        entry.misses += 1
        entry.lastAccessAt = this.clock()
      }
    })
    return { hit: false, reason, policyVersion: version.version }
  }

  /**
   * 回读旧版本条目：只读、不计数、不产生新版本数据。
   * 坏版本隔离：corrupt 版本返回 quarantined，不返回任何值。
   */
  readArchived(scope: CacheScope, policyId: string, version: number, key: string): CacheHitResult {
    const target = this.findVersion(policyId, version)
    if (!target) {
      return { hit: false, reason: 'missing', policyVersion: null }
    }
    if (target.corrupt) {
      return { hit: false, reason: 'quarantined', policyVersion: target.version }
    }
    const entry = this.readEntry(target, scope, key)
    if (!entry) {
      return { hit: false, reason: 'missing', policyVersion: target.version }
    }
    return {
      hit: true,
      value: this.cloneValue(entry.value),
      entry: { ...entry, value: this.cloneValue(entry.value) },
      policyVersion: target.version,
    }
  }

  // ---------------------------------------------------------------- 写路径（两个业务面共用）

  put(scope: CacheScope, policyId: string, key: string, value: unknown): PutResult {
    const version = this.requireActive(policyId)
    if (version.corrupt) {
      return { ok: false, reason: 'quarantined' }
    }
    if (!version.policy.enabled) {
      return { ok: false, reason: 'disabled' }
    }
    const now = this.clock()
    let evictedRefs: EvictionRef[] = []
    // 提交在后端原子落盘成功后才整体替换内存快照；若后端故障（含淘汰写入），
    // 错误直接向上抛，缓存保持上一次完整状态，不会出现部分删除或被清空。
    this.commit((draft) => {
      const target = draft.versions[this.activeIndex(policyId)]
      const existing = target.entries[scope][key]
      const record: CacheEntryRecord = {
        key,
        // 结构化克隆写入：迁移或外部传入的旧内存对象不会被直接注册进新版本。
        value: this.cloneValue(value),
        storedAt: now,
        ttlSeconds: target.policy.ttlSeconds,
        policyVersion: target.version,
        targetQuery: target.policy.targetQuery,
        scope,
        hits: existing?.hits ?? 0,
        misses: existing?.misses ?? 0,
        lastAccessAt: now,
      }
      target.entries[scope][key] = record
      evictedRefs = this.enforceQuota(draft, target)
    })
    return { ok: true, key, policyVersion: version.version, evictedRefs }
  }

  /** 容量淘汰：两个业务面合并计数，只删超出 maxEntries 的最少访问条目；异常由整包提交兜底，不会清空缓存。 */
  private enforceQuota(draft: CacheSnapshot, target: CacheVersionData): EvictionRef[] {
    const total = this.totalEntryCount(target)
    if (total <= target.policy.maxEntries) {
      return []
    }
    const overflow = total - target.policy.maxEntries
    const victims = this.allEntries(target)
      .sort((a, b) => a.lastAccessAt - b.lastAccessAt || a.storedAt - b.storedAt)
      .slice(0, overflow)
    const refs = victims.map((entry) => ({ scope: entry.scope, key: entry.key }))
    for (const ref of refs) {
      delete target.entries[ref.scope][ref.key]
    }
    this.writeEvidence(draft, target, 'quota', refs, 'executed')
    return refs
  }

  // ---------------------------------------------------------------- 淘汰计划与独立证据

  /**
   * 形成淘汰计划并（默认）执行。无论是否执行、执行是否失败，都会产出独立证据对象；
   * 命中率不低于阈值时计划保留为 deferred，不删任何条目。
   */
  planEviction(policyId: string, options: { reason?: EvictionReason; execute?: boolean } = {}): EvictionEvidence {
    const reason = options.reason ?? 'hit-rate-below-threshold'
    const execute = options.execute ?? true
    const target = this.requireActive(policyId)
    const now = this.clock()
    const candidates: EvictionCandidate[] = this.allEntries(target)
      .map((entry) => ({
        scope: entry.scope,
        key: entry.key,
        hits: entry.hits,
        misses: entry.misses,
        hitRate: this.entryHitRate(entry),
        ageSeconds: Math.max(0, Math.floor((now - entry.storedAt) / 1000)),
      }))
      .sort((a, b) => a.hitRate - b.hitRate || b.ageSeconds - a.ageSeconds)
    const hitRate = this.versionHitRate(target)
    const evidence: EvictionEvidence = {
      evidenceId: `ev-${this.tabId.slice(0, 8)}-${++this.evidenceSeq}`,
      policyId,
      policyVersion: target.version,
      reason,
      plannedAt: now,
      hitRate,
      threshold: target.policy.hitRateThreshold,
      candidates,
      evictedRefs: [],
      status: 'planned',
      plannedBy: this.tabId,
    }

    if (!execute) {
      // 只计划不执行：证据独立存档，缓存条目一个不动。
      evidence.status = 'planned'
      evidence.failure = '仅生成淘汰计划，未执行删除'
      this.persistEvidence(evidence)
      return evidence
    }
    const belowThreshold = reason === 'hit-rate-below-threshold' && hitRate < target.policy.hitRateThreshold
    if (reason === 'hit-rate-below-threshold' && !belowThreshold) {
      // 命中率不足阈值的淘汰计划必须形成单独证据：未达标就暂缓，证据保留为 deferred。
      evidence.status = 'deferred'
      evidence.failure = `命中率 ${hitRate.toFixed(3)} 未低于阈值 ${target.policy.hitRateThreshold}，计划暂缓执行`
      this.persistEvidence(evidence)
      return evidence
    }

    try {
      this.commit((draft) => {
        const live = draft.versions[this.activeIndex(policyId)]
        const refs = this.selectEvictionRefs(live, reason)
        for (const ref of refs) {
          delete live.entries[ref.scope][ref.key]
        }
        evidence.evictedRefs = refs
        evidence.executedAt = this.clock()
        evidence.status = 'executed'
        draft.evidence.push(this.cloneValue(evidence))
      })
    } catch (error) {
      // 淘汰提交失败：证据标记 failed，缓存一个条目都不会少。
      evidence.status = 'failed'
      evidence.failure = error instanceof Error ? error.message : String(error)
    }
    return evidence
  }

  private selectEvictionRefs(target: CacheVersionData, reason: EvictionReason): EvictionRef[] {
    const now = this.clock()
    if (reason === 'expired') {
      return this.allEntries(target)
        .filter((entry) => this.isExpired(entry, now))
        .map((entry) => ({ scope: entry.scope, key: entry.key }))
    }
    // 命中率类与手动淘汰：按命中率升序、最久未访问优先，淘汰末位 20%（至少 1 个）。
    const entries = this.allEntries(target)
    if (entries.length === 0) {
      return []
    }
    const count = Math.max(1, Math.ceil(entries.length * 0.2))
    return entries
      .sort((a, b) => this.entryHitRate(a) - this.entryHitRate(b) || a.lastAccessAt - b.lastAccessAt)
      .slice(0, count)
      .map((entry) => ({ scope: entry.scope, key: entry.key }))
  }

  private writeEvidence(
    draft: CacheSnapshot,
    target: CacheVersionData,
    reason: EvictionReason,
    evictedRefs: EvictionRef[],
    status: EvictionEvidence['status'],
  ): void {
    const now = this.clock()
    draft.evidence.push({
      evidenceId: `ev-${this.tabId.slice(0, 8)}-${++this.evidenceSeq}`,
      policyId: target.policyId,
      policyVersion: target.version,
      reason,
      plannedAt: now,
      executedAt: status === 'executed' ? now : undefined,
      hitRate: this.versionHitRate(target),
      threshold: target.policy.hitRateThreshold,
      candidates: evictedRefs.map((ref) => {
        const entry = target.entries[ref.scope][ref.key]
        return {
          scope: ref.scope,
          key: ref.key,
          hits: entry?.hits ?? 0,
          misses: entry?.misses ?? 0,
          hitRate: entry ? this.entryHitRate(entry) : 0,
          ageSeconds: entry ? Math.max(0, Math.floor((now - entry.storedAt) / 1000)) : 0,
        }
      }),
      evictedRefs,
      status,
      plannedBy: this.tabId,
    })
  }

  private persistEvidence(evidence: EvictionEvidence): void {
    this.commit((draft) => {
      draft.evidence.push(this.cloneValue(evidence))
    })
  }

  listEvidence(policyId?: string): EvictionEvidence[] {
    const all = this.snapshot.evidence
    return this.cloneValue(policyId ? all.filter((item) => item.policyId === policyId) : all)
  }

  // ---------------------------------------------------------------- 坏版本隔离与损坏恢复

  /** 隔离坏版本：标记 corrupt 并封存，数据保留但永不命中，其它版本不受影响。 */
  quarantineVersion(policyId: string, version: number, reason: string): void {
    const target = this.findVersion(policyId, version)
    if (!target) {
      throw new Error(`策略 ${policyId} 不存在 v${version}，无法隔离`)
    }
    this.commit(
      (draft) => {
        const live = draft.versions.find((item) => item.policyId === policyId && item.version === version)
        if (live) {
          live.corrupt = true
          live.quarantineReason = reason
          live.sealedAt = live.sealedAt ?? this.clock()
        }
      },
      { type: 'quarantine', detail: `策略 ${policyId} v${version} 被隔离：${reason}` },
    )
  }

  /** 持久存储损坏后的恢复报告（由后端在装载时生成）。 */
  recoveryReport(): RecoveryReport | null {
    return this.backend.lastRecovery()
  }

  // ---------------------------------------------------------------- 旧值迁移（只读旧值，不接管旧对象）

  /**
   * 接口迁移：把旧缓存里的值读出来写进当前策略版本。
   * 全程 JSON 克隆，旧内存对象不会被直接注册；停用/隔离策略拒绝写入。
   */
  migrateLegacyValues(scope: CacheScope, policyId: string, legacyEntries: LegacyEntry[]): MigrationResult {
    const target = this.requireActive(policyId)
    const result: MigrationResult = { migratedKeys: [], skipped: [] }
    if (target.corrupt) {
      for (const entry of legacyEntries) {
        result.skipped.push({ key: entry.key, reason: 'quarantined' })
      }
      return result
    }
    if (!target.policy.enabled) {
      for (const entry of legacyEntries) {
        result.skipped.push({ key: entry.key, reason: 'disabled' })
      }
      return result
    }
    const now = this.clock()
    const accepted: LegacyEntry[] = []
    for (const entry of legacyEntries) {
      try {
        // 先验证可序列化：含循环引用等无法跨版本迁移的旧对象直接拒绝，不污染新版本。
        const cloned = this.cloneValue(entry.value)
        accepted.push({ key: entry.key, value: cloned })
      } catch {
        result.skipped.push({ key: entry.key, reason: 'corrupt' })
      }
    }
    if (accepted.length === 0) {
      return result
    }
    this.commit(
      (draft) => {
        const live = draft.versions[this.activeIndex(policyId)]
        for (const item of accepted) {
          live.entries[scope][item.key] = {
            key: item.key,
            value: item.value,
            storedAt: now,
            ttlSeconds: live.policy.ttlSeconds,
            policyVersion: live.version,
            targetQuery: live.policy.targetQuery,
            scope,
            hits: 0,
            misses: 0,
            lastAccessAt: now,
          }
          result.migratedKeys.push(item.key)
        }
        this.enforceQuota(draft, live)
      },
      { type: 'migration', detail: `策略 ${policyId} 从旧接口迁移 ${accepted.length} 个值（只读旧值，重新构建条目对象）` },
    )
    return result
  }

  // ---------------------------------------------------------------- 多标签页与诊断

  onInvalidate(listener: (notice: InvalidationNotice) => void): () => void {
    this.invalidationListeners.add(listener)
    return () => this.invalidationListeners.delete(listener)
  }

  /** 测试专用：暂停接收远端提交，恢复时只采纳最后一个完整版本。 */
  pauseIncoming(): void {
    this.paused = true
  }

  resumeIncoming(): void {
    if (!this.paused) {
      return
    }
    this.paused = false
    const queued = this.queuedRemote
    this.queuedRemote = null
    if (queued) {
      this.adoptRemote(queued, 'external-commit')
    }
  }

  listVersions(policyId: string): { version: number; sealed: boolean; corrupt: boolean; entryCount: number; createdAt: number }[] {
    return this.snapshot.versions
      .filter((item) => item.policyId === policyId)
      .map((item) => ({
        version: item.version,
        sealed: item.sealedAt !== undefined,
        corrupt: item.corrupt === true,
        entryCount: this.totalEntryCount(item),
        createdAt: item.createdAt,
      }))
  }

  activeVersion(policyId: string): number {
    return this.requireActive(policyId).version
  }

  /** 诊断用：返回整包快照的深克隆，调用方任何修改都影响不到引擎内部状态。 */
  snapshotView(): CacheSnapshot {
    return cloneSnapshot(this.snapshot)
  }
}
