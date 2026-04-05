import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllData,
  createItemId,
  deleteCrawledItem,
  listItemCountsBySite,
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

  it('prefers dedupe key over title/url when present', () => {
    const first = createItemId(
      'twidouga-ranking-t1',
      'https://video.twimg.com/amplify_video/100/vid/a.mp4?tag=1',
      '1위 - https://x.com/a/status/100',
      ' twidouga:video-id:100 ',
    )
    const second = createItemId(
      'twidouga-ranking-t1',
      'https://video.twimg.com/ext_tw_video/100/pu/vid/b.mp4?tag=12',
      '5위 - https://x.com/i/status/100',
      'TWIDOUGA:VIDEO-ID:100',
    )

    expect(first).toBe(second)
  })

  it('skips already logged items instead of updating existing records', async () => {
    await upsertCrawledItems(
      'hacker-news',
      [
        {
          title: 'Item 1',
          url: 'https://example.com/a',
          summary: 'first',
          previewImageUrl: 'https://images.example.com/first.jpg',
        },
      ],
      100,
    )

    const result = await upsertCrawledItems(
      'hacker-news',
      [
        {
          title: 'Item 1',
          url: 'https://example.com/a',
          summary: 'second',
          previewImageUrl: 'https://images.example.com/second.jpg',
        },
      ],
      200,
    )

    const items = await listItemsBySite('hacker-news')
    const log = await db.crawledItemLogs.get(items[0]?.id ?? '')

    expect(items).toHaveLength(1)
    expect(result.insertedCount).toBe(0)
    expect(result.skippedCount).toBe(1)
    expect(items[0]).toMatchObject({
      title: 'Item 1',
      summary: 'first',
      previewImageUrl: 'https://images.example.com/first.jpg',
      crawledAt: 100,
    })
    expect(log).toMatchObject({
      firstSeenAt: 100,
      lastSeenAt: 200,
      seenCount: 2,
    })
  })

  it('returns deduplicated stored items for duplicate ids in one batch', async () => {
    const result = await upsertCrawledItems(
      'hacker-news',
      [
        {
          title: 'Item 1',
          url: 'https://example.com/a',
          summary: 'first',
        },
        {
          title: ' item 1 ',
          url: 'https://EXAMPLE.com/a',
          summary: 'second',
        },
      ],
      100,
    )

    const items = await listItemsBySite('hacker-news')

    expect(result.items).toHaveLength(1)
    expect(result.insertedCount).toBe(1)
    expect(result.skippedCount).toBe(0)
    expect(items).toHaveLength(1)
    expect(items[0]?.summary).toBe('second')
  })

  it('counts inserted and skipped items separately when records already exist', async () => {
    await upsertCrawledItems(
      'hacker-news',
      [{ title: 'Existing', url: 'https://example.com/existing' }],
      100,
    )

    const result = await upsertCrawledItems(
      'hacker-news',
      [
        { title: 'Existing', url: 'https://example.com/existing' },
        { title: 'New', url: 'https://example.com/new' },
      ],
      200,
    )

    expect(result.items).toHaveLength(1)
    expect(result.insertedCount).toBe(1)
    expect(result.skippedCount).toBe(1)
  })

  it('treats pre-existing items as already seen even when log is missing', async () => {
    await db.items.put({
      id: createItemId('hacker-news', 'https://example.com/existing', 'Existing'),
      siteId: 'hacker-news',
      title: 'Existing',
      url: 'https://example.com/existing',
      crawledAt: 50,
    })

    const result = await upsertCrawledItems(
      'hacker-news',
      [{ title: 'Existing', url: 'https://example.com/existing' }],
      100,
    )
    const existingId = createItemId(
      'hacker-news',
      'https://example.com/existing',
      'Existing',
    )
    const log = await db.crawledItemLogs.get(existingId)

    expect(result.insertedCount).toBe(0)
    expect(result.skippedCount).toBe(1)
    expect(log).toMatchObject({
      firstSeenAt: 50,
      lastSeenAt: 100,
      seenCount: 2,
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

  it('returns item counts for each requested site', async () => {
    await upsertCrawledItems('hacker-news', [
      { title: 'HN Item 1', url: 'https://news.ycombinator.com/item?id=1' },
      { title: 'HN Item 2', url: 'https://news.ycombinator.com/item?id=2' },
    ])

    await upsertCrawledItems('devto-latest', [
      { title: 'DEV Item', url: 'https://dev.to/dev/item' },
    ])

    const counts = await listItemCountsBySite([
      'hacker-news',
      'devto-latest',
      'missing-site',
    ])

    expect(counts).toEqual({
      'hacker-news': 2,
      'devto-latest': 1,
      'missing-site': 0,
    })
  })

  it('deletes a single item from the list', async () => {
    await upsertCrawledItems('hacker-news', [
      { title: 'Delete Me', url: 'https://news.ycombinator.com/item?id=10' },
      { title: 'Keep Me', url: 'https://news.ycombinator.com/item?id=11' },
    ])

    const beforeDelete = await listItemsBySite('hacker-news')
    const target = beforeDelete.find((item) => item.title === 'Delete Me')

    expect(target).toBeDefined()
    if (!target) {
      throw new Error('Target item not found')
    }

    await deleteCrawledItem(target.id)

    const afterDelete = await listItemsBySite('hacker-news')

    expect(afterDelete).toHaveLength(1)
    expect(afterDelete[0]?.title).toBe('Keep Me')
  })

  it('does not re-insert deleted items when crawl log already exists', async () => {
    await upsertCrawledItems(
      'hacker-news',
      [{ title: 'Seen Item', url: 'https://example.com/seen' }],
      100,
    )

    const [storedItem] = await listItemsBySite('hacker-news')
    if (!storedItem) {
      throw new Error('Stored item not found')
    }

    await deleteCrawledItem(storedItem.id)

    const recrawlResult = await upsertCrawledItems(
      'hacker-news',
      [{ title: 'Seen Item', url: 'https://example.com/seen' }],
      200,
    )
    const itemsAfterRecrawl = await listItemsBySite('hacker-news')

    expect(recrawlResult.insertedCount).toBe(0)
    expect(recrawlResult.skippedCount).toBe(1)
    expect(itemsAfterRecrawl).toHaveLength(0)
  })
})
