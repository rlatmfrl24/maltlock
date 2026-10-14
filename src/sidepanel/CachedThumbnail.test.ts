// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CachedThumbnail } from './CachedThumbnail'
import { loadPersistentThumbnail } from './thumbnail-cache'

vi.mock('./thumbnail-cache', () => ({ loadPersistentThumbnail: vi.fn() }))

it('retries a previously failed URL after the source changes away and back', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('IntersectionObserver', class {
    private callback: IntersectionObserverCallback
    constructor(callback: IntersectionObserverCallback) { this.callback = callback }
    observe(target: Element) {
      this.callback([{ target, isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    }
    disconnect() {}
  })
  const objectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:retry')
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
  vi.mocked(loadPersistentThumbnail)
    .mockResolvedValueOnce(undefined)
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValueOnce(new Blob(['image'], { type: 'image/png' }))
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  const render = async (sourceUrl: string) => {
    await act(async () => root.render(createElement(CachedThumbnail, { itemId: 'item-1', sourceUrl, title: 'Thumbnail' })))
  }
  try {
    await render('https://images.test/a.png')
    expect(host.textContent).toBe('미리보기 없음')
    await render('https://images.test/b.png')
    await render('https://images.test/a.png')
    expect(loadPersistentThumbnail).toHaveBeenCalledTimes(3)
    expect(host.querySelector('img')?.getAttribute('src')).toBe('blob:retry')
    expect(objectUrl).toHaveBeenCalledTimes(1)
  } finally {
    await act(async () => root.unmount())
    host.remove()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  }
})
