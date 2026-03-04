import Dexie, { type Table } from 'dexie'
import type { CrawledItem, CrawledItemLog, CrawlRun } from '../types/contracts'

export class MaltlockDatabase extends Dexie {
  items!: Table<CrawledItem, string>
  crawlRuns!: Table<CrawlRun, string>
  crawledItemLogs!: Table<CrawledItemLog, string>

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
  }
}

export const db = new MaltlockDatabase()
