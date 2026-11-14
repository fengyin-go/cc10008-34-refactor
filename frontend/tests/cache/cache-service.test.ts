import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createCacheService, MemoryCacheBackend, definePolicy } from '../../src/cache/index'

function policy() {
  return definePolicy({
    policyId: 'p-surface',
    targetQuery: '统一入口查询',
    keyRule: 'hash(参数)',
    ttlSeconds: 30,
    refreshTrigger: '手动',
    hitRateThreshold: 0.4,
    maxEntries: 4,
    evictionAlgorithm: 'LRU',
  })
}

test('聚合计算与交互查询经由同一个服务、同一引擎访问同一份版本化快照', () => {
  const service = createCacheService(new MemoryCacheBackend())
  const { aggregate, query, engine } = service

  aggregate.registerPolicy(policy())

  // 两个面写入同一策略的各自作用域，互不覆盖
  assert.equal(aggregate.put('p-surface', 'shared-key', { source: 'agg' }).ok, true)
  assert.equal(query.put('p-surface', 'shared-key', { source: 'query' }).ok, true)

  const aggHit = aggregate.get('p-surface', 'shared-key')
  const qryHit = query.get('p-surface', 'shared-key')
  assert.equal(aggHit.hit, true)
  assert.equal(qryHit.hit, true)
  if (aggHit.hit) assert.deepEqual(aggHit.value, { source: 'agg' })
  if (qryHit.hit) assert.deepEqual(qryHit.value, { source: 'query' })

  // 命中结果与直接走引擎完全一致（门面不另起一套缓存逻辑）
  const engineAgg = engine.get('aggregate', 'p-surface', 'shared-key')
  const engineQry = engine.get('query', 'p-surface', 'shared-key')
  assert.deepEqual(engineAgg.hit, aggHit.hit)
  assert.deepEqual(engineQry.hit, qryHit.hit)

  // 版本切换后两个面同时只认新版本
  aggregate.updatePolicy('p-surface', { ttlSeconds: 99 })
  assert.equal(engine.activeVersion('p-surface'), 2)
  assert.equal(aggregate.get('p-surface', 'shared-key').hit, false)
  assert.equal(query.get('p-surface', 'shared-key').hit, false)

  // 旧版本两个面都仍可回读
  assert.equal(aggregate.readArchived('p-surface', 1, 'shared-key').hit, true)
  assert.equal(query.readArchived('p-surface', 1, 'shared-key').hit, true)

  service.dispose()
})

test('失效提示通过统一服务广播，携带各策略当前生效版本', () => {
  const storage = new MemoryCacheBackend()
  const serviceA = createCacheService(storage)
  const serviceB = createCacheService(storage)
  serviceA.aggregate.registerPolicy(policy())
  serviceA.aggregate.put('p-surface', 'k', 1)

  const notices: Parameters<Parameters<typeof serviceB.onInvalidate>[0]>[0][] = []
  serviceB.onInvalidate((notice) => notices.push(notice))
  serviceA.aggregate.updatePolicy('p-surface', { maxEntries: 8 })

  assert.ok(notices.length >= 1)
  const last = notices[notices.length - 1]
  assert.equal(last.reason, 'external-commit')
  assert.equal(last.activeVersions['p-surface'], 2)
  serviceA.dispose()
  serviceB.dispose()
})
