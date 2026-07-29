import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import {
  clearAllData,
  createItemId,
  deleteCrawledItem,
  excludeItemFromSimilarityGroup,
  getItemBackfillProgress,
  listItemGroupsBySite,
  getCrawlDiagnostic,
  listItemCountsBySite,
  listItemsBySite,
  saveCrawlDiagnostic,
  runItemSignatureBackfillBatch,
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

  it('skips legacy torrentbot records by path when only the domain changes', async () => {
    const legacyId = createItemId(
      'torrentbot-topic-top20',
      'https://torrentbot230.site/topic/520409',
      'Same Topic',
    )

    await db.items.put({
      id: legacyId,
      siteId: 'torrentbot-topic-top20',
      title: 'Same Topic',
      url: 'https://torrentbot230.site/topic/520409',
      crawledAt: 100,
    })
    await db.crawledItemLogs.put({
      id: legacyId,
      siteId: 'torrentbot-topic-top20',
      itemId: legacyId,
      firstSeenAt: 100,
      lastSeenAt: 150,
      seenCount: 4,
    })

    const result = await upsertCrawledItems(
      'torrentbot-topic-top20',
      [
        {
          title: 'Same Topic',
          url: 'https://torrentbot999.site/topic/520409',
          dedupeKey: 'torrentbot:path:/topic/520409',
        },
      ],
      200,
    )
    const items = await listItemsBySite('torrentbot-topic-top20')
    const pathId = createItemId(
      'torrentbot-topic-top20',
      'https://torrentbot999.site/topic/520409',
      'Same Topic',
      'torrentbot:path:/topic/520409',
    )
    const pathLog = await db.crawledItemLogs.get(pathId)

    expect(result.insertedCount).toBe(0)
    expect(result.duplicateCount).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(legacyId)
    expect(pathLog).toMatchObject({
      itemId: legacyId,
      firstSeenAt: 100,
      lastSeenAt: 200,
      seenCount: 5,
    })
  })

  it('skips existing records by stable path across any site when only the domain changes', async () => {
    const legacyId = createItemId(
      'kone-pornvideo-hot',
      'https://kone.gg/s/pornvideo/abc123',
      'Same Post',
    )

    await db.items.put({
      id: legacyId,
      siteId: 'kone-pornvideo-hot',
      title: 'Same Post',
      url: 'https://kone.gg/s/pornvideo/abc123',
      crawledAt: 100,
    })
    await db.crawledItemLogs.put({
      id: legacyId,
      siteId: 'kone-pornvideo-hot',
      itemId: legacyId,
      firstSeenAt: 100,
      lastSeenAt: 100,
      seenCount: 1,
    })

    const result = await upsertCrawledItems(
      'kone-pornvideo-hot',
      [
        {
          title: 'Same Post',
          url: 'https://mirror.kone.gg/s/pornvideo/abc123',
        },
      ],
      200,
    )
    const items = await listItemsBySite('kone-pornvideo-hot')
    const newId = createItemId(
      'kone-pornvideo-hot',
      'https://mirror.kone.gg/s/pornvideo/abc123',
      'Same Post',
    )
    const legacyLog = await db.crawledItemLogs.get(legacyId)
    const newLog = await db.crawledItemLogs.get(newId)

    expect(result.insertedCount).toBe(0)
    expect(result.duplicateCount).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(legacyId)
    expect(legacyLog).toMatchObject({
      firstSeenAt: 100,
      lastSeenAt: 100,
      seenCount: 1,
    })
    expect(newLog).toMatchObject({
      itemId: legacyId,
      firstSeenAt: 100,
      lastSeenAt: 200,
      seenCount: 2,
    })
  })

  it('does not collapse different query-based board posts into one stable path', async () => {
    await upsertCrawledItems(
      'tcafe-d2001-hot-best',
      [
        {
          title: 'First Post',
          url: 'https://tcafe21.com/bbs/board.php?bo_table=D2001&wr_id=100',
        },
      ],
      100,
    )

    const result = await upsertCrawledItems(
      'tcafe-d2001-hot-best',
      [
        {
          title: 'Second Post',
          url: 'https://tcafe21.com/bbs/board.php?bo_table=D2001&wr_id=101',
        },
      ],
      200,
    )
    const items = await listItemsBySite('tcafe-d2001-hot-best')

    expect(result.insertedCount).toBe(1)
    expect(result.duplicateCount).toBe(0)
    expect(items).toHaveLength(2)
  })

  it('skips existing records by shared twitter media id when parser output changes shape', async () => {
    const legacyId = createItemId(
      'xranking-ranking',
      'https://pbs.twimg.com/ext_tw_video_thumb/333/pu/img/legacy.jpg?name=orig',
      'Legacy Thumb',
      'xranking:preview-id:333',
    )

    await db.items.put({
      id: legacyId,
      siteId: 'xranking-ranking',
      title: 'Legacy Thumb',
      url: 'https://pbs.twimg.com/ext_tw_video_thumb/333/pu/img/legacy.jpg?name=orig',
      crawledAt: 100,
    })

    const result = await upsertCrawledItems(
      'xranking-ranking',
      [
        {
          title: 'New Video',
          url: 'https://video.twimg.com/ext_tw_video/333/pu/vid/avc1/720x1280/new.mp4?tag=12',
          dedupeKey: 'xranking:video-id:333',
        },
      ],
      200,
    )
    const items = await listItemsBySite('xranking-ranking')

    expect(result.insertedCount).toBe(0)
    expect(result.duplicateCount).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(legacyId)
  })

  it('skips legacy nimi preview records when the new api reports the same video id', async () => {
    const legacyId = createItemId(
      'nimi-tw-ranking',
      'https://pbs.twimg.com/amplify_video_thumb/2054119491395858432/img/Uvxu5VE_fXU5BQio.jpg?name=orig',
      '1위 - 지윤',
      'nimi:preview-id:2054119491395858432',
    )

    await db.items.put({
      id: legacyId,
      siteId: 'nimi-tw-ranking',
      title: '1위 - 지윤',
      url: 'https://pbs.twimg.com/amplify_video_thumb/2054119491395858432/img/Uvxu5VE_fXU5BQio.jpg?name=orig',
      previewImageUrl:
        'https://pbs.twimg.com/amplify_video_thumb/2054119491395858432/img/Uvxu5VE_fXU5BQio.jpg?name=orig',
      crawledAt: 100,
    })
    await db.crawledItemLogs.put({
      id: legacyId,
      siteId: 'nimi-tw-ranking',
      itemId: legacyId,
      firstSeenAt: 100,
      lastSeenAt: 150,
      seenCount: 2,
    })

    const result = await upsertCrawledItems(
      'nimi-tw-ranking',
      [
        {
          title: '1위 - 지윤님의 동영상',
          url: 'https://video.twimg.com/amplify_video/2054119491395858432/vid/avc1/1280x720/zkA16ktZJFwEolKg.mp4?tag=14',
          previewImageUrl:
            'https://pbs.twimg.com/amplify_video_thumb/2054119491395858432/img/Uvxu5VE_fXU5BQio.jpg?name=orig',
          summary: 'https://x.com/jiyun_example/status/2054120219122725174',
          dedupeKey: 'nimi:video-id:2054119491395858432',
        },
      ],
      200,
    )
    const items = await listItemsBySite('nimi-tw-ranking')
    const newId = createItemId(
      'nimi-tw-ranking',
      'https://video.twimg.com/amplify_video/2054119491395858432/vid/avc1/1280x720/zkA16ktZJFwEolKg.mp4?tag=14',
      '1위 - 지윤님의 동영상',
      'nimi:video-id:2054119491395858432',
    )
    const legacyLog = await db.crawledItemLogs.get(legacyId)
    const newLog = await db.crawledItemLogs.get(newId)

    expect(result.insertedCount).toBe(0)
    expect(result.duplicateCount).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]?.id).toBe(legacyId)
    expect(newLog).toBeUndefined()
    expect(legacyLog).toMatchObject({
      itemId: legacyId,
      firstSeenAt: 100,
      lastSeenAt: 200,
      seenCount: 3,
    })
  })

  it('does not re-insert deleted legacy nimi preview records', async () => {
    const legacyId = createItemId(
      'nimi-tw-ranking',
      'https://pbs.twimg.com/ext_tw_video_thumb/2040767762675736576/pu/img/RffKoXzOQWfR9U-R.jpg?name=small',
      '1위 - 오메숍',
      'nimi:preview-id:2040767762675736576',
    )

    await db.crawledItemLogs.put({
      id: legacyId,
      siteId: 'nimi-tw-ranking',
      itemId: legacyId,
      firstSeenAt: 100,
      lastSeenAt: 100,
      seenCount: 1,
    })

    const result = await upsertCrawledItems(
      'nimi-tw-ranking',
      [
        {
          title: '1위 - 오메숍님의 동영상',
          url: 'https://video.twimg.com/ext_tw_video/2040767762675736576/pu/vid/avc1/656x512/6EQLHr05HYGvQUEO.mp4?tag=12',
          dedupeKey: 'nimi:video-id:2040767762675736576',
        },
      ],
      200,
    )
    const items = await listItemsBySite('nimi-tw-ranking')
    const legacyLog = await db.crawledItemLogs.get(legacyId)

    expect(result.insertedCount).toBe(0)
    expect(result.duplicateCount).toBe(1)
    expect(items).toHaveLength(0)
    expect(legacyLog).toMatchObject({
      firstSeenAt: 100,
      lastSeenAt: 200,
      seenCount: 2,
    })
  })

  it('refreshes thumbnail URLs without replacing existing item metadata', async () => {
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
    expect(result.duplicateCount).toBe(1)
    expect(items[0]).toMatchObject({
      title: 'Item 1',
      summary: 'first',
      previewImageUrl: 'https://images.example.com/second.jpg',
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
    expect(result.duplicateCount).toBe(1)
    expect(items).toHaveLength(1)
    expect(items[0]?.summary).toBe('second')
  })

  it('keeps the latest thumbnail for identity duplicates in one batch', async () => {
    const identity = {
      kind: 'source-id' as const,
      value: 'shared-post',
      scope: 'site' as const,
    }
    const result = await upsertCrawledItems('site-a', [
      {
        title: 'First shape',
        url: 'https://example.com/old',
        previewImageUrl: 'https://images.example.com/old.jpg',
        identities: [identity],
      },
      {
        title: 'Second shape',
        url: 'https://example.com/new',
        previewImageUrl: 'https://images.example.com/new.jpg',
        identities: [identity],
      },
    ])
    const items = await listItemsBySite('site-a')

    expect(result).toMatchObject({ insertedCount: 1, exactDuplicateCount: 1 })
    expect(items[0]?.previewImageUrl).toBe('https://images.example.com/new.jpg')
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
    expect(result.duplicateCount).toBe(1)
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
    expect(result.duplicateCount).toBe(1)
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
    expect(recrawlResult.duplicateCount).toBe(1)
    expect(itemsAfterRecrawl).toHaveLength(0)
  })

  it('does not re-insert deleted items when only the source domain changes', async () => {
    await upsertCrawledItems(
      'torrentbot-topic-top20',
      [
        {
          title: 'Same Topic',
          url: 'https://torrentbot230.site/topic/520409',
        },
      ],
      100,
    )

    const [storedItem] = await listItemsBySite('torrentbot-topic-top20')
    if (!storedItem) {
      throw new Error('Stored item not found')
    }

    await deleteCrawledItem(storedItem.id)

    const recrawlResult = await upsertCrawledItems(
      'torrentbot-topic-top20',
      [
        {
          title: 'Same Topic',
          url: 'https://torrentbot999.site/topic/520409',
        },
      ],
      200,
    )
    const itemsAfterRecrawl = await listItemsBySite('torrentbot-topic-top20')

    expect(recrawlResult.insertedCount).toBe(0)
    expect(recrawlResult.duplicateCount).toBe(1)
    expect(itemsAfterRecrawl).toHaveLength(0)
  })

  it('reports valid, duplicate, and rejected input counts separately', async () => {
    const result = await upsertCrawledItems('hacker-news', [
      { title: 'Valid', url: 'https://example.com/valid' },
      { title: 'Valid', url: 'https://example.com/valid' },
      { title: '   ', url: 'https://example.com/rejected' },
      { title: 'Invalid URL', url: 'not-a-url' },
    ])

    expect(result).toMatchObject({
      validCount: 2,
      insertedCount: 1,
      duplicateCount: 1,
      rejectedCount: 2,
    })
  })

  it('skips same-site exact identities even when URLs differ', async () => {
    const identity = { kind: 'source-id' as const, value: 'post-100', scope: 'site' as const }
    await upsertCrawledItems('site-a', [
      { title: 'Original title', url: 'https://example.com/old', identities: [identity] },
    ])
    const result = await upsertCrawledItems('site-a', [
      { title: 'Changed title', url: 'https://example.com/new', identities: [identity] },
    ])
    expect(result).toMatchObject({ insertedCount: 0, exactDuplicateCount: 1 })
  })

  it('stores cross-site global identities and puts them in one group', async () => {
    const identity = { kind: 'media-id' as const, value: 'video:555', scope: 'global' as const }
    await upsertCrawledItems('site-a', [
      { title: 'Source A title', url: 'https://a.example/555', identities: [identity] },
    ], 100)
    const result = await upsertCrawledItems('site-b', [
      { title: 'Source B title', url: 'https://b.example/555', identities: [identity] },
    ], 200)
    const groups = await listItemGroupsBySite('site-b')
    expect(result).toMatchObject({ insertedCount: 1, exactDuplicateCount: 0 })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.items).toHaveLength(2)
    expect(groups[0]?.reason).toBe('global-identity')
  })

  it('stores similar titles in a collapsed group and supports exclusion', async () => {
    await upsertCrawledItems('site-a', [
      { title: '1위 [HD] Example Amazing Video 1.2GB', url: 'https://example.com/one' },
    ], 100)
    const result = await upsertCrawledItems('site-a', [
      { title: '2위 Example Amazing Video 900MB', url: 'https://example.com/two' },
    ], 200)
    let groups = await listItemGroupsBySite('site-a')
    expect(result).toMatchObject({ insertedCount: 1, similarGroupedCount: 1, uniqueInsertedCount: 0 })
    expect(groups).toHaveLength(1)
    expect(groups[0]?.items).toHaveLength(2)

    const separated = groups[0]?.items.find((item) => item.url.endsWith('/two'))
    expect(separated).toBeDefined()
    await excludeItemFromSimilarityGroup(separated?.id ?? '')
    groups = await listItemGroupsBySite('site-a')
    expect(groups).toHaveLength(2)
    expect((await db.items.get(separated?.id ?? ''))?.similarityExcluded).toBe(true)
  })

  it('merges exact groups when a new item bridges global identities', async () => {
    await upsertCrawledItems('site-a', [{
      title: 'First global item', url: 'https://a.example/one',
      identities: [{ kind: 'media-id', value: 'video:one', scope: 'global' }],
    }], 100)
    await upsertCrawledItems('site-b', [{
      title: 'Second global item', url: 'https://b.example/two',
      identities: [{ kind: 'media-id', value: 'video:two', scope: 'global' }],
    }], 200)
    await upsertCrawledItems('site-c', [{
      title: 'Bridge global item', url: 'https://c.example/bridge',
      identities: [
        { kind: 'media-id', value: 'video:one', scope: 'global' },
        { kind: 'media-id', value: 'video:two', scope: 'global' },
      ],
    }], 300)
    const groups = await listItemGroupsBySite('site-c')
    expect(groups[0]?.items).toHaveLength(3)
    expect(new Set(groups[0]?.items.map((item) => item.contentGroupId)).size).toBe(1)
  })

  it('backfills legacy items in resumable idempotent batches', async () => {
    await db.items.bulkPut([
      { id: 'legacy-1', siteId: 'site-a', title: '1위 Legacy same long title 1.2GB', url: 'https://example.com/one', crawledAt: 1 },
      { id: 'legacy-2', siteId: 'site-a', title: '2위 Legacy same long title 900MB', url: 'https://example.com/two', crawledAt: 2 },
    ])
    const first = await runItemSignatureBackfillBatch(1)
    expect(first).toMatchObject({ processed: 1, total: 2, complete: false })
    const second = await runItemSignatureBackfillBatch(1)
    expect(second).toMatchObject({ processed: 2, total: 2, complete: true })
    const signatureCount = await db.itemSignatures.count()
    expect(await runItemSignatureBackfillBatch(1)).toEqual(second)
    expect(await db.itemSignatures.count()).toBe(signatureCount)
    expect((await getItemBackfillProgress()).complete).toBe(true)
    expect((await db.items.get('legacy-1'))?.normalizedTitle).toBeTruthy()
    expect((await listItemGroupsBySite('site-a'))[0]?.items).toHaveLength(2)
  })

  it('keeps only the configured number of diagnostics per site', async () => {
    for (let index = 1; index <= 4; index += 1) {
      await saveCrawlDiagnostic(
        {
          runId: `run-${index}`,
          siteId: 'site-1',
          createdAt: index,
          inputSource: 'dom-html',
          mimeType: 'text/html',
          encoding: 'gzip',
          originalBytes: 1,
          storedBytes: 1,
          payload: new Uint8Array([index]),
        },
        { maxPerSite: 3, maxAgeMs: 1_000 },
      )
    }

    expect(await getCrawlDiagnostic('run-1')).toBeUndefined()
    expect(await getCrawlDiagnostic('run-2')).toBeDefined()
    expect(await db.crawlDiagnostics.count()).toBe(3)
  })

  it('removes diagnostics older than the retention window', async () => {
    await saveCrawlDiagnostic(
      {
        runId: 'old-run',
        siteId: 'site-1',
        createdAt: 1,
        inputSource: 'dom-html',
        mimeType: 'text/html',
        encoding: 'gzip',
        originalBytes: 1,
        storedBytes: 1,
        payload: new Uint8Array([1]),
      },
      { maxPerSite: 3, maxAgeMs: 1_000 },
    )
    await saveCrawlDiagnostic(
      {
        runId: 'new-run',
        siteId: 'site-2',
        createdAt: 2_000,
        inputSource: 'api-json',
        mimeType: 'application/json',
        encoding: 'gzip',
        originalBytes: 1,
        storedBytes: 1,
        payload: new Uint8Array([2]),
      },
      { maxPerSite: 3, maxAgeMs: 1_000 },
    )

    expect(await getCrawlDiagnostic('old-run')).toBeUndefined()
    expect(await getCrawlDiagnostic('new-run')).toBeDefined()
  })
})
