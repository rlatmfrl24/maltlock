import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { konePornvideoHotParser } from './kone-pornvideo-hot.parser'

function loadFixture(): string {
  const fixturePath = new URL('../../public/sample/kone_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('konePornvideoHotParser', () => {
  it('extracts preview image, url and title from kone hot listing', () => {
    const html = loadFixture()

    const items = konePornvideoHotParser(html, 'https://kone.gg/s/pornvideo?mode=hot')

    expect(items.length).toBeGreaterThan(20)

    const hasInvalidTitle = items.some((item) => !item.title.trim())
    const hasMissingPreview = items.some((item) => !item.previewImageUrl?.startsWith('https://'))
    const hasInvalidUrl = items.some(
      (item) =>
        !item.url.startsWith('https://kone.gg/s/pornvideo/') ||
        !item.url.includes('?mode=hot') ||
        item.url.includes('?p=') ||
        item.url.includes('&p='),
    )

    expect(hasInvalidTitle).toBe(false)
    expect(hasMissingPreview).toBe(false)
    expect(hasInvalidUrl).toBe(false)
  })
})
