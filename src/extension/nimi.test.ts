import { describe, expect, it } from 'vitest'
import { buildNimiApiUrl, getNimiActivePeriod, getNimiActiveView } from './nimi'

describe('nimi helper', () => {
  it('builds the current ranking api url from active tab and period markup', () => {
    const html = `
      <div class="hidden md:flex">
        <a class="tab-active text-white" href="ranking">인기</a>
        <a class="text-violet-200" href="realtime">실시간</a>
        <a class="text-violet-200" href="recent">신규</a>
      </div>
      <div class="inline-flex bg-white/10 rounded-xl p-1">
        <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all bg-violet-500 text-white shadow-lg shadow-violet-500/50">1시간</button>
        <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all text-violet-200 hover:text-white hover:bg-white/10">1일</button>
      </div>
    `

    expect(getNimiActiveView(html, 'https://tw.nimi.wiki/')).toBe('ranking')
    expect(getNimiActivePeriod(html, 'https://tw.nimi.wiki/')).toBe('hourly')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/')).toBe(
      'https://tw.nimi.wiki/api/tw/ranking?period=hourly',
    )
  })

  it('uses the active period button text from the current nimi markup', () => {
    const html = `
      <a class="tab-active text-white" href="ranking">인기</a>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all text-violet-200 hover:text-white hover:bg-white/10">1시간</button>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all bg-violet-500 text-white shadow-lg shadow-violet-500/50">1주</button>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all text-violet-200 hover:text-white hover:bg-white/10">1달</button>
    `

    expect(getNimiActivePeriod(html, 'https://tw.nimi.wiki/')).toBe('weekly')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/')).toBe(
      'https://tw.nimi.wiki/api/tw/ranking?period=weekly',
    )
  })

  it('uses the tab url to detect realtime and recent pages', () => {
    const html = `
      <a class="tab-active text-white" href="ranking">인기</a>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all bg-violet-500 text-white shadow-lg shadow-violet-500/50">1시간</button>
    `

    expect(getNimiActiveView(html, 'https://tw.nimi.wiki/realtime')).toBe('realtime')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/realtime')).toBe(
      'https://tw.nimi.wiki/api/tw/realtime',
    )
    expect(getNimiActiveView(html, 'https://tw.nimi.wiki/recent')).toBe('recent')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/recent')).toBe(
      'https://tw.nimi.wiki/api/tw/recent',
    )
  })

  it('honors explicit period query params from a custom target url', () => {
    const html = `
      <a class="tab-active text-white" href="ranking">인기</a>
      <button class="px-3 py-2 rounded-lg text-sm font-medium transition-all bg-violet-500 text-white shadow-lg shadow-violet-500/50">1시간</button>
    `

    expect(getNimiActivePeriod(html, 'https://tw.nimi.wiki/?period=daily')).toBe('daily')
    expect(buildNimiApiUrl(html, 'https://tw.nimi.wiki/?period=daily')).toBe(
      'https://tw.nimi.wiki/api/tw/ranking?period=daily',
    )
  })
})
