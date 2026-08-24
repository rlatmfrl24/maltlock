import { describe, expect, it } from 'vitest'
import { getTargetSiteById, siteMatchesUrl } from './targets'

describe('targetSites', () => {
  it('uses the current NimiWiki host and retains legacy host compatibility', () => {
    const site = getTargetSiteById('nimi-tw-ranking')

    expect(site?.url).toBe('https://video.nimi.wiki/tw/ranking/week')
    expect(
      site && siteMatchesUrl(site, 'https://video.nimi.wiki/tw/ranking/week'),
    ).toBe(true)
    expect(
      site && siteMatchesUrl(site, 'https://tw2.nimi.wiki/ranking/week'),
    ).toBe(true)
  })

  it('registers the ydkorea tab with the requested popular listing', () => {
    const site = getTargetSiteById('ydkorea-popular-best')

    expect(site).toEqual({
      id: 'ydkorea-popular-best',
      name: 'ydkorea',
      url: 'https://yadongkorea02.tv/popular?vType=best&bo_table=korea',
      matchPatterns: ['https://yadongkorea02.tv/*'],
      parserId: 'ydkorea-popular-best',
    })
    expect(
      site &&
        siteMatchesUrl(
          site,
          'https://yadongkorea02.tv/popular?vType=best&bo_table=korea',
        ),
    ).toBe(true)
  })
})
