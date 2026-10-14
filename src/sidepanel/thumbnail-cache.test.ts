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

  it('loads the image when Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }))))

    expect((await loadPersistentThumbnail('item-1', 'https://images.test/one.png'))?.type).toBe('image/png')
  })

  it('returns the downloaded image when the cache write fails', async () => {
    cache.put.mockRejectedValueOnce(new Error('Quota exceeded'))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }))))

    expect((await loadPersistentThumbnail('item-1', 'https://images.test/one.png'))?.type).toBe('image/png')
  })

  it('displays before a slow cache write finishes and removes that write on deletion', async () => {
    let finishWrite!: () => void
    let startedWrite!: () => void
    const started = new Promise<void>((resolve) => { startedWrite = resolve })
    const heldWrite = new Promise<void>((resolve) => { finishWrite = resolve })
    cache.put.mockImplementationOnce(async (key, response) => {
      startedWrite()
      await heldWrite
      responses.set(`${key}`, response.clone())
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Blob(['image'], { type: 'image/png' }))))
    const loaded = vi.fn()
    const loading = loadPersistentThumbnail('item-1', 'https://images.test/one.png').then(loaded)
    await started
    try {
      await vi.waitFor(() => expect(loaded).toHaveBeenCalledWith(expect.objectContaining({ type: 'image/png' })))
      expect(responses.size).toBe(0)
      const deleting = removePersistentThumbnail('item-1')
      await Promise.resolve()
      await Promise.resolve()
      expect(cache.delete).not.toHaveBeenCalled()
      finishWrite()
      await deleting
      expect(responses.size).toBe(0)
    } finally {
      finishWrite()
      await loading
    }
  })

  it('does not persist a thumbnail after its caller cancels', async () => {
    let finish!: (response: Response) => void
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve }))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const pending = loadPersistentThumbnail('item-1', 'https://images.test/one.png', controller.signal)
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()
    finish(new Response(new Blob(['image'], { type: 'image/png' })))
    await pending

    expect(responses.size).toBe(0)
  })
})
