import type { CachePolicy } from './types'

/**
 * 策略版本指纹：只有影响「命中语义」的字段进指纹。
 * - 过期秒数、最大条目数变化 → 必然开出新版本
 * - 目标查询改名 → 新版本，且旧缓存不得被接管
 * - 命中率阈值只影响淘汰计划，不改变命中结果，不产生新版本（淘汰证据里单独记录）
 */
export function policyFingerprint(policy: Pick<CachePolicy, 'targetQuery' | 'ttlSeconds' | 'maxEntries'>): string {
  return `${policy.targetQuery}#ttl=${policy.ttlSeconds}#max=${policy.maxEntries}`
}

export function validatePolicy(policy: CachePolicy): void {
  if (!policy.policyId || typeof policy.policyId !== 'string') {
    throw new Error('缓存策略必须有策略编号')
  }
  if (!policy.targetQuery.trim()) {
    throw new Error('目标查询名称不能为空')
  }
  if (!Number.isFinite(policy.ttlSeconds) || policy.ttlSeconds <= 0) {
    throw new Error('过期秒数必须是正数')
  }
  if (!Number.isInteger(policy.maxEntries) || policy.maxEntries <= 0) {
    throw new Error('最大条目数必须是正整数')
  }
  if (!Number.isFinite(policy.hitRateThreshold) || policy.hitRateThreshold < 0 || policy.hitRateThreshold > 1) {
    throw new Error('命中率阈值必须位于 0 到 1 之间')
  }
}

export function definePolicy(input: Omit<CachePolicy, 'enabled'> & { enabled?: boolean }): CachePolicy {
  const policy: CachePolicy = {
    policyId: input.policyId,
    targetQuery: input.targetQuery,
    keyRule: input.keyRule,
    ttlSeconds: input.ttlSeconds,
    refreshTrigger: input.refreshTrigger,
    hitRateThreshold: input.hitRateThreshold,
    maxEntries: input.maxEntries,
    evictionAlgorithm: input.evictionAlgorithm,
    enabled: input.enabled ?? true,
  }
  validatePolicy(policy)
  return policy
}
