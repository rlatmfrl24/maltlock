import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { konePornvideoHotParser } from './kone-pornvideo-hot.parser'

function loadFixture(): string {
  const fixturePath = new URL('../../public/sample/kone_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

function loadFixture2(): string {
  const fixturePath = new URL('../../public/sample/kone_example2.html', import.meta.url)
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

  it('extracts items from kone hot listing fixture #2', () => {
    const html = loadFixture2()

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

  it('parses all articles even when packed payload is split across script chunks', () => {
    const html = `
      <script>
        self.__next_f = self.__next_f || [];
        self.__next_f.push([1, '25:T4f20,[{"id":{"__t":"u","v":"article-1"},"title":"First title","preview":"https://img.example.com/first.jpg","has_m',]);
      </script>
      <script>
        self.__next_f.push([1, 'edia":true},{"id":{"__t":"u","v":"article-2"},"title":"Second title","preview":"https://img.example.com/second.jpg","has_media":true}]',]);
      </script>
    `

    const items = konePornvideoHotParser(html, 'https://kone.gg/s/pornvideo?mode=hot')

    expect(items).toHaveLength(2)
    expect(items).toEqual([
      {
        title: 'First title',
        url: 'https://kone.gg/s/pornvideo/article-1?mode=hot',
        previewImageUrl: 'https://img.example.com/first.jpg',
      },
      {
        title: 'Second title',
        url: 'https://kone.gg/s/pornvideo/article-2?mode=hot',
        previewImageUrl: 'https://img.example.com/second.jpg',
      },
    ])
  })

  it('parses packed payload wrapped in double-quoted next_f chunks', () => {
    const html = `
      <script>
        self.__next_f = self.__next_f || [];
        self.__next_f.push([1, "25:T4f20,[{\\"id\\":{\\"__t\\":\\"u\\",\\"v\\":\\"article-3\\"},\\"title\\":\\"Third title\\",\\"preview\\":\\"https://img.example.com/third.jpg\\",\\"has_media\\":true}]"]);
      </script>
    `

    const items = konePornvideoHotParser(html, 'https://kone.gg/s/pornvideo?mode=hot')

    expect(items).toEqual([
      {
        title: 'Third title',
        url: 'https://kone.gg/s/pornvideo/article-3?mode=hot',
        previewImageUrl: 'https://img.example.com/third.jpg',
      },
    ])
  })

  it('falls back to dom parsing without crossorigin attribute', () => {
    const html = `
      <div class="relative group/post-wrapper">
        <a title="Dom title" href="/s/pornvideo/dom-article?p=1&amp;mode=hot">title</a>
        <img src="https://img.example.com/dom.jpg" alt="Dom title" />
      </div>
    `

    const items = konePornvideoHotParser(html, 'https://kone.gg/s/pornvideo?mode=hot')

    expect(items).toEqual([
      {
        title: 'Dom title',
        url: 'https://kone.gg/s/pornvideo/dom-article?mode=hot',
        previewImageUrl: 'https://img.example.com/dom.jpg',
      },
    ])
  })
})
