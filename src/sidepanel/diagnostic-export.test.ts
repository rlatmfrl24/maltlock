import { describe, expect, it } from 'vitest'
import type { CrawlDiagnosticArtifact, CrawlRun } from '../types/contracts'
import { createCrawlDiagnosticExport } from './diagnostic-export'

const run: CrawlRun = {
  runId: 'run-1',
  siteId: 'site-1',
  startedAt: 100,
  finishedAt: 200,
  status: 'failed',
  parsedCount: 0,
  errorCode: 'PARSE_EMPTY',
}

describe('createCrawlDiagnosticExport', () => {
  it('exports run metadata without requiring a raw artifact', () => {
    expect(createCrawlDiagnosticExport(run, undefined, undefined)).toMatchObject({
      run,
      artifact: undefined,
    })
  })

  it('replaces compressed bytes with restored payload text', () => {
    const artifact: CrawlDiagnosticArtifact = {
      runId: 'run-1',
      siteId: 'site-1',
      createdAt: 200,
      inputSource: 'dom-html',
      mimeType: 'text/html',
      encoding: 'gzip',
      originalBytes: 10,
      storedBytes: 5,
      payload: new Uint8Array([1, 2, 3]),
    }

    const exported = createCrawlDiagnosticExport(run, artifact, '<html></html>')

    expect(exported.artifact).toMatchObject({
      runId: 'run-1',
      payloadText: '<html></html>',
    })
    expect(exported.artifact).not.toHaveProperty('payload')
  })
})
