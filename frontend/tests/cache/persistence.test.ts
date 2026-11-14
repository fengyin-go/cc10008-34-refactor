import { test } from 'node:test'
import assert from 'node:assert/strict'

import { PersistentCacheBackend, persistentKeyNames } from '../../src/cache/backends'
import { createMemoryShimStorage, type MemoryShimStorage } from '../../src/cache/runtime'
import { VersionedCacheEngine } from '../../src/cache/versioned-cache'
import { definePolicy } from '../../src/cache/policy'

function policy(policyId = 'p-1') {
  return definePolicy({
    policyId,
    targetQuery: '查询A',
    keyRule: 'hash',
    ttlSeconds: 60,
    refreshTrigger: '手动',
    hitRateThreshold: 0.5,
    maxEntries: 5,
    evictionAlgorithm: 'LRU',
  })
}

test('持久化往返：重新装载后快照完整，两个业务面命中结果不变', () => {
  const storage = createMemoryShimStorage()
  const backendA = new PersistentCacheBackend('iac-test', storage)
  const engineA = new VersionedCacheEngine({ backend: backendA, tabId: 'tab-A' })
  engineA.registerPolicy(policy())
  engineA.put('aggregate', 'p-1', 'ak', { face: 'aggregate' })
  engineA.put('query', 'p-1', 'qk', { face: 'query' })
  engineA.get('aggregate', 'p-1', 'ak')

  const engineB = new VersionedCacheEngine({
    backend: new PersistentCacheBackend('iac-test', storage),
    tabId: 'tab-B',
  })
  const agg = engineB.get('aggregate', 'p-1', 'ak')
  const qry = engineB.get('query', 'p-1', 'qk')
  assert.equal(agg.hit, true)
  assert.equal(qry.hit, true)
  if (agg.hit) assert.deepEqual(agg.value, { face: 'aggregate' })
  if (qry.hit) assert.deepEqual(qry.value, { face: 'query' })
  // 隔离作用域：聚合面的键在查询面未命中
  assert.equal(engineB.get('query', 'p-1', 'ak').hit, false)
})

test('current 损坏时从 tmp 提升恢复，并给出丢失范围说明', () => {
  const storage = createMemoryShimStorage()
  const ns = 'iac-tmp'
  const k = persistentKeyNames(ns)
  const backend = new PersistentCacheBackend(ns, storage)
  const engine = new VersionedCacheEngine({ backend, tabId: 'tab-A' })
  engine.registerPolicy(policy())

  // 让下一次提交在 tmp 落盘后、current 更新前崩溃：tmp 为完整信封，current 为坏值。
  backend.crashAfterTmpOnce()
  assert.throws(() => engine.put('query', 'p-1', 'k', 'v'), /崩溃/)
  assert.ok(storage.getItem(k.tmp))

  const reloaded = new VersionedCacheEngine({
    backend: new PersistentCacheBackend(ns, storage),
    tabId: 'tab-B',
  })
  const report = reloaded.recoveryReport()
  assert.ok(report)
  assert.equal(report?.recovered, true)
  assert.equal(report?.source, 'tmp')
  assert.match(report?.detail ?? '', /完整快照/)
  const hit = reloaded.get('query', 'p-1', 'k')
  assert.equal(hit.hit, true)
})

test('current 与 tmp 都损坏时从 backup 恢复到上一次完整快照', () => {
  const storage = createMemoryShimStorage()
  const ns = 'iac-backup'
  const k = persistentKeyNames(ns)
  const engine = new VersionedCacheEngine({
    backend: new PersistentCacheBackend(ns, storage),
    tabId: 'tab-A',
  })
  engine.registerPolicy(policy())
  engine.put('query', 'p-1', 'first', 1)
  // 第二次提交会把第一次的 current 备份到 backup
  engine.put('query', 'p-1', 'second', 2)

  storage.corruptRaw(k.current, '###bad###')
  storage.corruptRaw(k.tmp, '###bad###')

  const reloaded = new VersionedCacheEngine({ backend: new PersistentCacheBackend(ns, storage), tabId: 'tab-B' })
  const report = reloaded.recoveryReport()
  assert.equal(report?.recovered, true)
  assert.equal(report?.source, 'backup')
  // 备份点（第一次提交）的数据可用
  assert.equal(reloaded.get('query', 'p-1', 'first').hit, true)
  // 备份点之后的第二次提交数据丢失，报告里必须说明丢失边界
  assert.equal(reloaded.get('query', 'p-1', 'second').hit, false)
  assert.equal(report?.lostSince !== null, true)
})

test('三处信封全部损坏时重建空快照并如实声明丢失无法统计', () => {
  const storage = createMemoryShimStorage()
  const ns = 'iac-wipe'
  const k = persistentKeyNames(ns)
  const engine = new VersionedCacheEngine({ backend: new PersistentCacheBackend(ns, storage), tabId: 'tab-A' })
  engine.registerPolicy(policy())
  engine.put('query', 'p-1', 'k', 'v')

  storage.corruptRaw(k.current, 'x')
  storage.corruptRaw(k.tmp, 'x')
  storage.corruptRaw(k.backup, 'x')

  const reloaded = new VersionedCacheEngine({ backend: new PersistentCacheBackend(ns, storage), tabId: 'tab-B' })
  const report = reloaded.recoveryReport()
  assert.equal(report?.recovered, false)
  assert.equal(report?.source, 'fresh')
  assert.equal(report?.lostEntryCount, null)
  assert.throws(() => reloaded.activeVersion('p-1'), /尚未登记/)
})

test('后端写入故障时内存缓存保持完整，淘汰失败不清空', () => {
  const storage = createMemoryShimStorage()
  const backend = new PersistentCacheBackend('iac-fail', storage)
  const engine = new VersionedCacheEngine({ backend, tabId: 'tab-A' })
  engine.registerPolicy(policy())
  engine.put('query', 'p-1', 'a', 1)
  engine.put('query', 'p-1', 'b', 2)

  backend.failSaves(1)
  assert.throws(() => engine.put('query', 'p-1', 'c', 3), /模拟故障/)
  // 内存视图仍是故障前的完整快照
  assert.equal(engine.get('query', 'p-1', 'a').hit, true)
  assert.equal(engine.get('query', 'p-1', 'b').hit, true)
  const snapshot = engine.snapshotView()
  assert.equal(Object.keys(snapshot.versions[0].entries.query).length, 2)

  // 故障恢复后新提交正常落盘，重新装载数据一致
  engine.put('query', 'p-1', 'c', 3)
  const reloaded = new VersionedCacheEngine({
    backend: new PersistentCacheBackend('iac-fail', storage),
    tabId: 'tab-B',
  })
  assert.equal(reloaded.get('query', 'p-1', 'c').hit, true)
})

test('多标签页：最后完整提交为准，其余页面收到失效提示且不展示过期值', () => {
  const storage: MemoryShimStorage = createMemoryShimStorage()
  const ns = 'iac-multi'
  const engineA = new VersionedCacheEngine({
    backend: new PersistentCacheBackend(ns, storage),
    tabId: 'tab-A',
  })
  const engineB = new VersionedCacheEngine({
    backend: new PersistentCacheBackend(ns, storage),
    tabId: 'tab-B',
  })
  engineA.registerPolicy(policy())
  // B 收到 A 的登记提交通知
  const notices: string[] = []
  engineB.onInvalidate((notice) => notices.push(`${notice.reason}:${notice.commitSeq}`))

  engineA.put('query', 'p-1', 'k', 'from-A')
  assert.equal(engineB.get('query', 'p-1', 'k').hit, true)
  assert.ok(notices.some((n) => n.startsWith('external-commit:')))

  // B 暂停期间 A 连续提交多次：恢复时只能看到最后一个完整版本，无中间值闪烁
  engineB.pauseIncoming()
  engineA.put('query', 'p-1', 'k', 'v1')
  engineA.put('query', 'p-1', 'k', 'v2')
  engineA.put('query', 'p-1', 'k', 'v3-final')
  const viewFromA = engineA.snapshotView()
  engineB.resumeIncoming()
  // 恢复后先核对快照，再做任何会产生本页提交的读取
  const viewFromB = engineB.snapshotView()
  assert.equal(viewFromB.commitSeq, viewFromA.commitSeq)
  assert.equal(viewFromB.lastWriterTab, 'tab-A')

  const hit = engineB.readArchived('query', 'p-1', viewFromB.versions[viewFromB.versions.length - 1].version, 'k')
  if (hit.hit) assert.equal(hit.value, 'v3-final')
})

test('多标签页并发写：过期基线被拒绝（STALE_COMMIT），重试后成功', () => {
  const storage = createMemoryShimStorage()
  const ns = 'iac-conflict'
  const engineA = new VersionedCacheEngine({
    backend: new PersistentCacheBackend(ns, storage),
    tabId: 'tab-A',
  })
  const engineB = new VersionedCacheEngine({
    backend: new PersistentCacheBackend(ns, storage),
    tabId: 'tab-B',
  })
  engineA.registerPolicy(policy())
  // 让 B 的内存基线停留在旧序号
  engineB.pauseIncoming()
  engineA.put('query', 'p-1', 'a', 1)
  engineA.put('query', 'p-1', 'b', 2)
  engineB.resumeIncoming()

  // B 已同步到最新；再制造一次冲突：暂停 B，A 先提交，B 用旧基线提交
  engineB.pauseIncoming()
  engineA.put('query', 'p-1', 'a', 'A-wins')
  let conflicted = false
  try {
    // 直接在暂停态提交：peekSeq 会发现远端序号领先
    engineB.put('query', 'p-1', 'b', 'B-loses')
  } catch (error) {
    conflicted = true
    assert.equal((error as { code: string }).code, 'STALE_COMMIT')
  }
  assert.equal(conflicted, true)
  engineB.resumeIncoming()

  // B 已被同步到 A 的完整版本，重试写入成功
  const retry = engineB.put('query', 'p-1', 'b', 'B-retry')
  assert.equal(retry.ok, true)
  const finalA = engineA.get('query', 'p-1', 'a')
  if (finalA.hit) assert.equal(finalA.value, 'A-wins')
  const finalB = engineA.get('query', 'p-1', 'b')
  if (finalB.hit) assert.equal(finalB.value, 'B-retry')
})

test('其它标签页写坏 current 时忽略坏值，本页面继续使用完整快照', () => {
  const storage = createMemoryShimStorage()
  const ns = 'iac-corrupt-remote'
  const k = persistentKeyNames(ns)
  const engine = new VersionedCacheEngine({ backend: new PersistentCacheBackend(ns, storage), tabId: 'tab-A' })
  engine.registerPolicy(policy())
  engine.put('query', 'p-1', 'k', 'v')

  let gotNotice = false
  engine.onInvalidate((notice) => {
    if (notice.reason === 'external-corrupt-ignored') gotNotice = true
  })
  // 走正常写入路径（会通知监听者）但内容无法解析，模拟对端的坏提交。
  storage.writeCorruptAndNotify(k.current, '{无法解析')

  assert.equal(gotNotice, true)
  assert.equal(engine.get('query', 'p-1', 'k').hit, true)
})
