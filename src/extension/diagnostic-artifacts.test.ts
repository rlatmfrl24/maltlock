import {
  createDiagnosticArtifact,
  createInputHash,
  decompressDiagnosticPayload,
  MAX_DIAGNOSTIC_INPUT_BYTES,
} from './diagnostic-artifacts'
import { describe, expect, it } from 'vitest'

describe('diagnostic artifacts', () => {
  it('hashes input deterministically with SHA-256', async () => {
    const first = await createInputHash('fixture')
    const second = await createInputHash('fixture')

    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
  })

  it('compresses and restores a diagnostic payload', async () => {
    const result = await createDiagnosticArtifact({
      runId: 'run-1',
      siteId: 'site-1',
      createdAt: 100,
      inputSource: 'dom-html',
      content: '<html><body>fixture</body></html>',
    })

    expect(result.warning).toBeUndefined()
    expect(result.artifact).toBeDefined()
    expect(await decompressDiagnosticPayload(result.artifact!)).toBe(
      '<html><body>fixture</body></html>',
    )
  })

  it('does not store inputs larger than 2MiB', async () => {
    const result = await createDiagnosticArtifact({
      runId: 'run-large',
      siteId: 'site-1',
      createdAt: 100,
      inputSource: 'dom-html',
      content: 'x'.repeat(MAX_DIAGNOSTIC_INPUT_BYTES + 1),
    })

    expect(result).toEqual({ warning: 'PAYLOAD_TOO_LARGE' })
  })
})
