import type { CacheSnapshot, PersistedEnvelope } from './types'

/**
 * 运行环境适配层：浏览器里用 localStorage + storage 事件，Node 测试里注入内存假存储。
 * 业务引擎不直接碰 window/localStorage，多标签页语义全部在这里收口。
 */

export type SimpleStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type StorageChangeListener = (event: { key: string; newValue: string | null; storageArea: SimpleStorage }) => void

function resolveDefaultStorage(): SimpleStorage | null {
  if (typeof globalThis === 'undefined') {
    return null
  }
  const candidate = (globalThis as { localStorage?: SimpleStorage }).localStorage
  return candidate ?? null
}

/**
 * 多标签页内存假存储：同一 key 的写入会同步通知所有监听者，模拟浏览器的 storage 事件
 * （真实浏览器只在其它文档派发，本实现派发时携带 writerTab，由引擎自行过滤自己）。
 */
export class MemoryShimStorage implements SimpleStorage {
  private data = new Map<string, string>()
  private listeners = new Set<StorageChangeListener>()

  getItem(key: string): string | null {
    return this.data.has(key) ? this.data.get(key)! : null
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value)
    for (const listener of [...this.listeners]) {
      listener({ key, newValue: value, storageArea: this })
    }
  }

  removeItem(key: string): void {
    this.data.delete(key)
    for (const listener of [...this.listeners]) {
      listener({ key, newValue: null, storageArea: this })
    }
  }

  /** 测试专用：直接写坏内容且不发通知，模拟进程在写入中途崩溃。 */
  corruptRaw(key: string, value: string): void {
    this.data.set(key, value)
  }

  /** 测试专用：以正常写入路径写坏内容并通知所有监听者，模拟其它标签页提交了坏信封。 */
  writeCorruptAndNotify(key: string, value: string): void {
    this.setItem(key, value)
  }

  subscribe(listener: StorageChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

export function createMemoryShimStorage(): MemoryShimStorage {
  return new MemoryShimStorage()
}

export class BrowserStorageBridge {
  readonly storage: SimpleStorage

  constructor(storage?: SimpleStorage) {
    this.storage = storage ?? resolveDefaultStorage() ?? createMemoryShimStorage()
  }

  /** 监听同一持久键被其它标签页改写；返回退订函数。 */
  onChange(listener: StorageChangeListener): () => void {
    const shim = this.storage as MemoryShimStorage
    if (typeof shim.subscribe === 'function') {
      return shim.subscribe(listener)
    }
    if (typeof globalThis !== 'undefined' && typeof globalThis.addEventListener === 'function') {
      const handler = (event: StorageEvent) => {
        if (event.storageArea === this.storage || !event.storageArea) {
          listener({ key: event.key ?? '', newValue: event.newValue, storageArea: this.storage })
        }
      }
      globalThis.addEventListener('storage', handler as EventListener)
      return () => globalThis.removeEventListener('storage', handler as EventListener)
    }
    return () => undefined
  }
}

export function cloneSnapshot(snapshot: CacheSnapshot): CacheSnapshot {
  return JSON.parse(JSON.stringify(snapshot)) as CacheSnapshot
}

export function serializeEnvelope(envelope: PersistedEnvelope): string {
  return JSON.stringify(envelope)
}

/** 快照信封的结构校验：字段缺失或类型不对都视为损坏，不能静默当成空缓存。 */
export function isEnvelope(value: unknown): value is PersistedEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const envelope = value as Record<string, unknown>
  if (envelope.format !== 'iac-cache-envelope/v1' || typeof envelope.commitSeq !== 'number') {
    return false
  }
  const snapshot = envelope.snapshot as Record<string, unknown> | undefined
  if (!snapshot || snapshot.format !== 'iac-cache-snapshot/v1' || !Array.isArray(snapshot.versions)) {
    return false
  }
  return Array.isArray(snapshot.evidence) && Array.isArray(snapshot.audit)
}

export function createTabId(): string {
  if (typeof globalThis !== 'undefined' && typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
