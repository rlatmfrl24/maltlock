import { describe, expect, it } from 'vitest'
import { getTargetSiteById, siteMatchesUrl } from './targets'

describe('targetSites', () => {
  it('uses and accepts the current NimiWiki host after the legacy redirect', () => {
    const site = getTargetSiteById('nimi-tw-ranking')

    expect(site?.url).toBe('https://tw3.nimi.wiki/ranking/week')
    expect(
      site && siteMatchesUrl(site, 'https://tw3.nimi.wiki/ranking/week'),
    ).toBe(true)
    expect(
      site && siteMatchesUrl(site, 'https://tw2.nimi.wiki/ranking/week'),
    ).toBe(true)
  })
})
