import { describe, expect, it } from 'vitest'
import { hackerNewsParser } from './hacker-news.parser'

describe('hackerNewsParser', () => {
  it('extracts titleline anchors and dedupes by url+title', () => {
    const html = `
      <table>
        <tr class="athing">
          <td><span class="titleline"><a href="https://example.com/a"> First Item </a></span></td>
        </tr>
        <tr class="athing">
          <td><span class="titleline"><a href="item?id=123">Second <b>Item</b></a></span></td>
        </tr>
        <tr class="athing">
          <td><span class="titleline"><a href="https://example.com/a">First Item</a></span></td>
        </tr>
      </table>
    `

    const items = hackerNewsParser(html, 'https://news.ycombinator.com/')

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      title: 'First Item',
      url: 'https://example.com/a',
    })
    expect(items[1]).toMatchObject({
      title: 'Second Item',
      url: 'https://news.ycombinator.com/item?id=123',
    })
  })
})
