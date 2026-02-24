import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllData,
  createItemId,
  listItemsBySite,
  upsertCrawledItems,
} from './repository'
import { db } from './schema'

describe('repository', () => {
  beforeEach(async () => {
    await clearAllData()
  })

  afterAll(async () => {
    await db.delete()
    db.close()
  })

  it('creates stable item id regardless of title/url casing', () => {
    const first = createItemId('hacker-news', 'https://example.com/a', 'Hello')
    const second = createItemId('hacker-news', 'https://EXAMPLE.com/a', ' hello ')

    expect(first).toBe(second)
  })

  it('upserts duplicate items instead of creating multiple records', async () => {
    await upsertCrawledItems(
      'hacker-news',
      [{ title: 'Item 1', url: 'https://example.com/a', summary: 'first' }],
      100,
    )

    await upsertCrawledItems(
      'hacker-news',
      [{ title: 'Item 1', url: 'https://example.com/a', summary: 'second' }],
      200,
    )

    const items = await listItemsBySite('hacker-news')

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'Item 1',
      summary: 'second',
      crawledAt: 200,
    })
  })

  it('separates site data by tab site id', async () => {
    await upsertCrawledItems('hacker-news', [
      { title: 'HN Item', url: 'https://news.ycombinator.com/item?id=1' },
    ])

    await upsertCrawledItems('devto-latest', [
      { title: 'DEV Item', url: 'https://dev.to/dev/item' },
    ])

    const hnItems = await listItemsBySite('hacker-news')
    const devItems = await listItemsBySite('devto-latest')

    expect(hnItems).toHaveLength(1)
    expect(devItems).toHaveLength(1)
    expect(hnItems[0]?.title).toBe('HN Item')
    expect(devItems[0]?.title).toBe('DEV Item')
  })
})
