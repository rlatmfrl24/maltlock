import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  loadPersistentThumbnail,
  removePersistentThumbnail,
} from './thumbnail-cache'

describe('thumbnail cache', () => {
  const responses = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (key: RequestInfo | URL) =>
      responses.get(`${key}`)?.clone(),
    ),
    put: vi.fn(async (key: RequestInfo | URL, response: Response) => {
      responses.set(`${key}`, response.clone())
    }),
    keys: vi.fn(async () => [...responses.keys()].map((key) => new Request(key))),
    delete: vi.fn(async (key: RequestInfo | URL) => responses.delete(`${key}`)),
  }

  beforeEach(() => {
    responses.clear()
    vi.clearAllMocks()
    vi.stubGlobal('caches', {
      open: vi.fn(async () => cache),
      delete: vi.fn(async () => true),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reuses a cached thumbnail without requesting the remote URL again', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Blob(['image'], { type: 'image/png' }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const first = await loadPersistentThumbnail('item-1', 'https://images.test/one.png')
    const second = await loadPersistentThumbnail('item-1', 'https://images.test/one.png')

    expect(first?.type).toBe('image/png')
    expect(second?.type).toBe('image/png')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the previous cached image when a refreshed URL fails', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(new Blob(['image'], { type: 'image/jpeg' }), { status: 200 }),
      )
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', fetchMock)

    await loadPersistentThumbnail('item-1', 'https://images.test/old.jpg')
    const fallback = await loadPersistentThumbnail(
      'item-1',
      'https://images.test/expired.jpg',
    )

    expect(fallback?.type).toBe('image/jpeg')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('removes cached data when the item is deleted', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(new Blob(['image'], { type: 'image/webp' }), { status: 200 }),
      ),
    )
    await loadPersistentThumbnail('item-1', 'https://images.test/one.webp')
    await removePersistentThumbnail('item-1')

    expect(responses.size).toBe(0)
  })
})
