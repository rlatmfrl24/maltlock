import Dexie, { type Table } from 'dexie'
import type {
  CrawledItem,
  CrawledItemLog,
  CrawlDiagnosticArtifact,
  CrawlRun,
  ItemSignature,
  AppMeta,
} from '../types/contracts'

export class MaltlockDatabase extends Dexie {
  items!: Table<CrawledItem, string>
  crawlRuns!: Table<CrawlRun, string>
  crawledItemLogs!: Table<CrawledItemLog, string>
  crawlDiagnostics!: Table<CrawlDiagnosticArtifact, string>
  itemSignatures!: Table<ItemSignature, string>
  appMeta!: Table<AppMeta, string>

  constructor() {
    super('maltlock-db')

    this.version(1).stores({
      items: 'id, siteId, crawledAt, [siteId+crawledAt]',
      crawlRuns: 'runId, siteId, startedAt, finishedAt, status, [siteId+startedAt]',
    })

    this.version(2).stores({
      items: 'id, siteId, crawledAt, [siteId+crawledAt]',
      crawlRuns: 'runId, siteId, startedAt, finishedAt, status, [siteId+startedAt]',
      crawledItemLogs:
        'id, siteId, itemId, firstSeenAt, lastSeenAt, seenCount, [siteId+lastSeenAt]',
    })

    this.version(3).stores({
      items: 'id, siteId, crawledAt, [siteId+crawledAt]',
      crawlRuns: 'runId, siteId, startedAt, finishedAt, status, [siteId+startedAt]',
      crawledItemLogs:
        'id, siteId, itemId, firstSeenAt, lastSeenAt, seenCount, [siteId+lastSeenAt]',
      crawlDiagnostics: 'runId, siteId, createdAt, [siteId+createdAt]',
    })

    this.version(4).stores({
      items:
        'id, siteId, crawledAt, contentGroupId, [siteId+crawledAt], [siteId+contentGroupId]',
      crawlRuns: 'runId, siteId, startedAt, finishedAt, status, [siteId+startedAt]',
      crawledItemLogs:
        'id, siteId, itemId, firstSeenAt, lastSeenAt, seenCount, [siteId+lastSeenAt]',
      crawlDiagnostics: 'runId, siteId, createdAt, [siteId+createdAt]',
      itemSignatures:
        'id, itemId, siteId, kind, scope, valueHash, [scope+kind+valueHash], [siteId+kind+valueHash], [siteId+kind]',
      appMeta: 'key, updatedAt',
    })
  }
}

export const db = new MaltlockDatabase()
