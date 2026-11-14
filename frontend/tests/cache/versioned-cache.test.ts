import { test } from 'node:test'
import assert from 'node:assert/strict'

import { definePolicy } from '../../src/cache/policy'
import { MemoryCacheBackend } from '../../src/cache/backends'
import { VersionedCacheEngine } from '../../src/cache/versioned-cache'
import type { CachePolicy } from '../../src/cache/types'

function makePolicy(overrides: Partial<CachePolicy> = {}): CachePolicy {
  return definePolicy({
    policyId: 'p-1',
    targetQuery: '订单明细查询',
    keyRule: 'hash(参数)',
    ttlSeconds: 60,
    refreshTrigger: '手动',
    hitRateThreshold: 0.5,
    maxEntries: 3,
    evictionAlgorithm: 'LRU',
    ...overrides,
  })
}

function makeEngine(now?: () => number, tabId = 'tab-A') {
  return new VersionedCacheEngine({ backend: new MemoryCacheBackend(), now, tabId })
}

test('两个业务面共用同一版本：聚合面与查询面命中结果一致且互不串键', () => {
  const engine = makeEngine()
  engine.registerPolicy(makePolicy())
  engine.put('aggregate', 'p-1', 'k1', { rows: 1 })
  engine.put('query', 'p-1', 'k1', { rows: 2 })

  const agg = engine.get('aggregate', 'p-1', 'k1')
  const qry = engine.get('query', 'p-1', 'k1')
  assert.equal(agg.hit, true)
  assert.equal(qry.hit, true)
  if (agg.hit) assert.deepEqual(agg.value, { rows: 1 })
  if (qry.hit) assert.deepEqual(qry.value, { rows: 2 })

  // 同一 scope 不存在的键按未命中处理
  const miss = engine.get('query', 'p-1', 'nope')
  assert.equal(miss.hit, false)
  if (!miss.hit) assert.equal(miss.reason, 'missing')
})

test('过期秒数变化产生新策略版本：旧键可回读但不能命中新查询', () => {
  let current = 1_000_000
  const engine = makeEngine(() => current)
  engine.registerPolicy(makePolicy({ ttlSeconds: 60 }))
  engine.put('query', 'p-1', 'old-key', 'v1')
  assert.equal(engine.activeVersion('p-1'), 1)

  const bumped = engine.updatePolicy('p-1', { ttlSeconds: 120 })
  assert.equal(bumped.bumped, true)
  assert.equal(engine.activeVersion('p-1'), 2)

  // 新版本查不到旧键（未命中，原因是缺失；旧版本条目不会挂到新版本下）
  const newHit = engine.get('query', 'p-1', 'old-key')
  assert.equal(newHit.hit, false)

  // 旧版本仍可只读回读
  const archived = engine.readArchived('query', 'p-1', 1, 'old-key')
  assert.equal(archived.hit, true)
  if (archived.hit) assert.equal(archived.value, 'v1')

  const versions = engine.listVersions('p-1')
  assert.equal(versions.length, 2)
  assert.equal(versions[0].sealed, true)
  assert.equal(versions[1].sealed, false)
})

test('最大条目数变化同样产生新版本，阈值变化不开新版本', () => {
  const engine = makeEngine()
  engine.registerPolicy(makePolicy())
  const a = engine.updatePolicy('p-1', { maxEntries: 9 })
  assert.equal(a.bumped, true)
  assert.equal(a.version, 2)
  const b = engine.updatePolicy('p-1', { hitRateThreshold: 0.2 })
  assert.equal(b.bumped, false)
  assert.equal(b.version, 2)
})

test('TTL 到期：不命中但条目保留，可通过归档读取到原条目', () => {
  let current = 0
  const engine = makeEngine(() => current)
  engine.registerPolicy(makePolicy({ ttlSeconds: 10 }))
  engine.put('query', 'p-1', 'k', 'x')
  current = 9_999
  assert.equal(engine.get('query', 'p-1', 'k').hit, true)
  current = 10_000
  const expired = engine.get('query', 'p-1', 'k')
  assert.equal(expired.hit, false)
  if (!expired.hit) assert.equal(expired.reason, 'expired')
  // 条目并未被删除（分表结构下统计两个业务面的条目总数）
  const snapshot = engine.snapshotView()
  const total = Object.values(snapshot.versions[0].entries).reduce((sum, table) => sum + Object.keys(table).length, 0)
  assert.equal(total, 1)
})

test('目标查询改名后旧缓存不能被新策略接管', () => {
  const engine = makeEngine()
  engine.registerPolicy(makePolicy({ targetQuery: '旧查询' }))
  engine.put('query', 'p-1', 'k', 'legacy')

  const bumped = engine.updatePolicy('p-1', { targetQuery: '新查询' })
  assert.equal(bumped.bumped, true)
  // 新版本命中失败
  const hit = engine.get('query', 'p-1', 'k')
  assert.equal(hit.hit, false)
  // 旧版本回读仍然可用，且其 targetQuery 仍是旧名
  const archived = engine.readArchived('query', 'p-1', 1, 'k')
  assert.equal(archived.hit, true)
  if (archived.hit) {
    assert.equal(archived.entry.targetQuery, '旧查询')
    assert.equal(archived.entry.policyVersion, 1)
  }
})

test('坏版本隔离：隔离后不命中、不回读，其它版本正常', () => {
  const engine = makeEngine()
  engine.registerPolicy(makePolicy())
  engine.put('query', 'p-1', 'k', 'v')
  engine.updatePolicy('p-1', { ttlSeconds: 30 })
  engine.put('query', 'p-1', 'k2', 'v2')

  engine.quarantineVersion('p-1', 1, '校验和不匹配')
  const archived = engine.readArchived('query', 'p-1', 1, 'k')
  assert.equal(archived.hit, false)
  if (!archived.hit) assert.equal(archived.reason, 'quarantined')

  // 当前版本不受影响
  const live = engine.get('query', 'p-1', 'k2')
  assert.equal(live.hit, true)

  const versions = engine.listVersions('p-1')
  assert.equal(versions.find((v) => v.version === 1)?.corrupt, true)
})

test('容量淘汰只删超额条目，淘汰失败不清空任何缓存', () => {
  const backend = new MemoryCacheBackend()
  // 前两次提交正常落盘，第三次（触发容量淘汰的写入）在持久化环节故障。
  let saves = 0
  const flaky = new MemoryCacheBackend()
  flaky.save = (snapshot, writerTab) => {
    saves += 1
    // 登记、写 a、写 b 各一次提交；第四次写 c（触发容量淘汰）时故障。
    if (saves === 4) {
      throw new Error('模拟持久化故障')
    }
    backend.save(snapshot, writerTab)
  }
  // 让故障后端的读路径指向正常后端，保证装载与并发校验一致。
  flaky.load = () => backend.load()
  flaky.peekSeq = () => backend.peekSeq()
  flaky.lastRecovery = () => backend.lastRecovery()
  flaky.subscribe = (listener) => backend.subscribe(listener)
  const failing = new VersionedCacheEngine({ backend: flaky })
  failing.registerPolicy(makePolicy({ maxEntries: 2 }))
  failing.put('query', 'p-1', 'a', 1)
  failing.put('query', 'p-1', 'b', 2)

  // 第三个写入触发淘汰，但后端整体提交失败：必须抛错且缓存保持两条完整数据
  assert.throws(() => failing.put('query', 'p-1', 'c', 3), /模拟持久化故障/)
  const snapshot = failing.snapshotView()
  const active = snapshot.versions[snapshot.versions.length - 1]
  assert.deepEqual(Object.keys(active.entries.query).sort(), ['a', 'b'])

  // 正常引擎里容量淘汰按 LRU 删除最久未访问的条目，并产出证据。
  // 注入单调时钟，避免同毫秒时间戳让 LRU 比较失效。
  let tick = 0
  const good = makeEngine(() => (tick += 1))
  good.registerPolicy(makePolicy({ maxEntries: 2 }))
  good.put('query', 'p-1', 'a', 1)
  good.put('query', 'p-1', 'b', 2)
  good.get('query', 'p-1', 'a') // a 被访问，b 成为 LRU 末位
  const result = good.put('query', 'p-1', 'c', 3)
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.ok(result.evictedRefs.some((ref) => ref.scope === 'query' && ref.key === 'b'))
  }
  const remaining = Object.keys(good.snapshotView().versions[0].entries.query).sort()
  assert.deepEqual(remaining, ['a', 'c'])
  assert.ok(good.listEvidence('p-1').some((e) => e.status === 'executed' && e.reason === 'quota'))
})

test('命中率不足阈值的淘汰计划形成单独证据，未达标时暂缓不删数据', () => {
  const engine = makeEngine()
  engine.registerPolicy(makePolicy({ hitRateThreshold: 0.5 }))
  engine.put('query', 'p-1', 'a', 1)
  engine.put('query', 'p-1', 'b', 2)
  // 制造低命中率：4 次未命中、1 次命中 → 0.2 < 0.5
  engine.get('query', 'p-1', 'a')
  for (let i = 0; i < 4; i += 1) engine.get('query', 'p-1', 'missing')

  const evidence = engine.planEviction('p-1')
  assert.equal(evidence.status, 'executed')
  assert.equal(evidence.reason, 'hit-rate-below-threshold')
  assert.ok(evidence.hitRate < 0.5)
  assert.ok(evidence.evictedRefs.length >= 1)

  // 命中率达标场景：计划保留 deferred，形成证据但不删条目
  const engine2 = makeEngine()
  engine2.registerPolicy(makePolicy({ hitRateThreshold: 0.9 }))
  engine2.put('query', 'p-1', 'x', 1)
  engine2.get('query', 'p-1', 'x')
  const before = Object.keys(engine2.snapshotView().versions[0].entries.query).length
  const deferred = engine2.planEviction('p-1')
  assert.equal(deferred.status, 'deferred')
  const after = Object.keys(engine2.snapshotView().versions[0].entries.query).length
  assert.equal(after, before)
  assert.ok(engine2.listEvidence('p-1').some((e) => e.evidenceId === deferred.evidenceId))

  // 只计划不执行也必须留证（execute=false 时不看阈值，证据独立存档且不删条目）
  const planned = engine2.planEviction('p-1', { execute: false })
  assert.equal(planned.status, 'planned')
  assert.deepEqual(planned.evictedRefs, [])
})

test('策略停用后不再产生新条目，旧条目仍可回读', () => {
  const engine = makeEngine()
  engine.registerPolicy(makePolicy())
  engine.put('query', 'p-1', 'k', 'v')
  engine.setEnabled('p-1', false)

  const rejected = engine.put('query', 'p-1', 'k2', 'v2')
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.equal(rejected.reason, 'disabled')

  const hit = engine.get('query', 'p-1', 'k')
  assert.equal(hit.hit, true)
  const archived = engine.readArchived('query', 'p-1', 1, 'k')
  assert.equal(archived.hit, true)
})

test('接口迁移只读旧值：重新构建条目对象，旧内存对象不会被直接注册', () => {
  const engine = makeEngine()
  engine.registerPolicy(makePolicy())
  const oldObject = { nested: { value: 1 } }
  const result = engine.migrateLegacyValues('query', 'p-1', [{ key: 'legacy', value: oldObject }])
  assert.deepEqual(result.migratedKeys, ['legacy'])

  const hit = engine.get('query', 'p-1', 'legacy')
  assert.equal(hit.hit, true)
  // 改写旧对象不影响缓存内部（证明存的是克隆而非同一引用）
  oldObject.nested.value = 999
  const again = engine.get('query', 'p-1', 'legacy')
  if (again.hit) assert.deepEqual(again.value, { nested: { value: 1 } })

  const snapshot = engine.snapshotView()
  const entry = snapshot.versions[0].entries.query.legacy
  assert.equal(entry.policyVersion, 1)
  assert.equal(entry.targetQuery, '订单明细查询')

  // 无法序列化的旧对象被拒绝并记录原因
  const circular: Record<string, unknown> = {}
  circular.self = circular
  const bad = engine.migrateLegacyValues('query', 'p-1', [{ key: 'cycle', value: circular }])
  assert.deepEqual(bad.migratedKeys, [])
  assert.equal(bad.skipped[0].reason, 'corrupt')

  // 停用策略拒绝迁移写入
  engine.setEnabled('p-1', false)
  const stopped = engine.migrateLegacyValues('query', 'p-1', [{ key: 'z', value: 1 }])
  assert.equal(stopped.skipped[0].reason, 'disabled')
})

test('返回值与快照视图均为深克隆，外部修改无法污染引擎内部', () => {
  const engine = makeEngine()
  engine.registerPolicy(makePolicy())
  engine.put('query', 'p-1', 'k', { list: [1, 2] })
  const hit = engine.get('query', 'p-1', 'k')
  if (hit.hit) {
    ;(hit.value as { list: number[] }).list.push(3)
  }
  const again = engine.get('query', 'p-1', 'k')
  if (again.hit) assert.deepEqual(again.value, { list: [1, 2] })

  const view = engine.snapshotView()
  view.versions[0].entries.query['k'].value = 'tampered'
  const fresh = engine.snapshotView()
  assert.notEqual(fresh.versions[0].entries.query['k'].value, 'tampered')
})

test('无存储写故障时提交序号单调递增且审计留痕', () => {
  const engine = makeEngine(undefined, 'tab-A')
  engine.registerPolicy(makePolicy())
  engine.put('query', 'p-1', 'k', 1)
  const snapshot = engine.snapshotView()
  assert.equal(snapshot.commitSeq, 2)
  assert.ok(snapshot.audit.some((e) => e.type === 'policy-registered' && e.tabId === 'tab-A'))
})
