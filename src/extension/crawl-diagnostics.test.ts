import type { CrawlRun } from '../types/contracts'
import { describe, expect, it } from 'vitest'
import {
  classifyCrawlOutcome,
  clipErrorDetail,
  hasConsecutiveParserFailures,
} from './crawl-diagnostics'

function createRun(overrides: Partial<CrawlRun>): CrawlRun {
  return {
    runId: crypto.randomUUID(),
    siteId: 'test-site',
    startedAt: 1,
    finishedAt: 2,
    status: 'success',
    ...overrides,
  }
}

describe('classifyCrawlOutcome', () => {
  it('treats duplicate-only recrawls as success', () => {
    expect(
      classifyCrawlOutcome({ parsedCount: 10, validCount: 10, rejectedCount: 0 }),
    ).toEqual({ status: 'success' })
  })

  it('classifies empty and fully rejected parser output as failures', () => {
    expect(
      classifyCrawlOutcome({ parsedCount: 0, validCount: 0, rejectedCount: 0 }),
    ).toEqual({ status: 'failed', errorCode: 'PARSE_EMPTY' })
    expect(
      classifyCrawlOutcome({ parsedCount: 2, validCount: 0, rejectedCount: 2 }),
    ).toEqual({ status: 'failed', errorCode: 'NORMALIZATION_EMPTY' })
  })

  it('classifies partially rejected output as partial', () => {
    expect(
      classifyCrawlOutcome({ parsedCount: 3, validCount: 2, rejectedCount: 1 }),
    ).toEqual({ status: 'partial' })
  })
})

describe('crawl failure diagnostics', () => {
  it('requires two consecutive new parser failures', () => {
    const runs = [
      createRun({ status: 'failed', parsedCount: 0, errorCode: 'PARSE_EMPTY' }),
      createRun({ status: 'failed', parsedCount: 1, errorCode: 'PARSE_FAILED' }),
    ]

    expect(hasConsecutiveParserFailures(runs)).toBe(true)
    expect(
      hasConsecutiveParserFailures([
        runs[0]!,
        createRun({ status: 'failed', parsedCount: 0, errorCode: 'TAB_URL_MISMATCH' }),
        runs[1]!,
      ]),
    ).toBe(true)
  })

  it('ignores legacy runs without parsed count', () => {
    expect(
      hasConsecutiveParserFailures([
        createRun({ status: 'failed', errorCode: 'NO_ITEMS' }),
        createRun({ status: 'failed', parsedCount: 0, errorCode: 'PARSE_EMPTY' }),
      ]),
    ).toBe(false)
  })

  it('clips persisted error details to 2KB', () => {
    expect(clipErrorDetail('x'.repeat(3_000))).toHaveLength(2_048)
  })
})
