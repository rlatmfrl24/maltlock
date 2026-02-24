import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllData,
  createItemId,
  deleteCrawledItem,
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

    await upsertCrawledItems(
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

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'Item 1',
      summary: 'second',
      previewImageUrl: 'https://images.example.com/second.jpg',
      crawledAt: 200,
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
    expect(result.updatedCount).toBe(0)
    expect(items).toHaveLength(1)
    expect(items[0]?.summary).toBe('second')
  })

  it('counts inserted and updated items separately when records already exist', async () => {
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

    expect(result.items).toHaveLength(2)
    expect(result.insertedCount).toBe(1)
    expect(result.updatedCount).toBe(1)
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
})
