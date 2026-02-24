import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { torrentbotTopicTop20Parser } from './torrentbot-topic-top20.parser'

function loadFixture(): string {
  const fixturePath = new URL('../../public/sample/torrentbot_example.html', import.meta.url)
  return readFileSync(fixturePath, 'utf-8')
}

describe('torrentbotTopicTop20Parser', () => {
  it('extracts top20 list title and url rows', () => {
    const html = loadFixture()

    const items = torrentbotTopicTop20Parser(
      html,
      'https://torrentbot230.site/topic/index?top=20',
    )

    expect(items).toHaveLength(20)

    const first = items[0]
    expect(first?.title).toBe('군산대 할카스 보지에 점있는 녀 3V19P')
    expect(first?.url).toBe('https://torrentbot230.site/topic/520409')
    expect(first?.summary).toContain('1위')
    expect(first?.summary).toContain('12.11')

    const hasPreviewImage = items.some((item) => Boolean(item.previewImageUrl))
    expect(hasPreviewImage).toBe(false)
  })
})
