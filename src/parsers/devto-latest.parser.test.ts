import { describe, expect, it } from 'vitest'
import { devtoLatestParser } from './devto-latest.parser'

describe('devtoLatestParser', () => {
  it('parses article-link pattern', () => {
    const html = `
      <a id="article-link-1" href="/alice/post-a">  Post A  </a>
      <a id="article-link-2" href="https://dev.to/bob/post-b">Post B</a>
    `

    const items = devtoLatestParser(html, 'https://dev.to/latest')

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: 'Post A',
      url: 'https://dev.to/alice/post-a',
    })
    expect(items[1]).toMatchObject({
      title: 'Post B',
      url: 'https://dev.to/bob/post-b',
    })
  })

  it('falls back to heading links when article-link is missing', () => {
    const html = `
      <h2><a href="/charlie/post-c"> Post C </a></h2>
    `

    const items = devtoLatestParser(html, 'https://dev.to/latest')

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      title: 'Post C',
      url: 'https://dev.to/charlie/post-c',
    })
  })
})
