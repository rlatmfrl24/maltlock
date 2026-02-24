import Dexie, { type Table } from 'dexie'
import type { CrawledItem, CrawlRun } from '../types/contracts'

export class MaltlockDatabase extends Dexie {
  items!: Table<CrawledItem, string>
  crawlRuns!: Table<CrawlRun, string>

  constructor() {
    super('maltlock-db')

    this.version(1).stores({
      items: 'id, siteId, crawledAt, [siteId+crawledAt]',
      crawlRuns: 'runId, siteId, startedAt, finishedAt, status, [siteId+startedAt]',
    })
  }
}

export const db = new MaltlockDatabase()
