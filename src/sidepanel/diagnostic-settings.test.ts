import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DIAGNOSTIC_CAPTURE_ENABLED,
  DIAGNOSTIC_CAPTURE_STORAGE_KEY,
  readDiagnosticCaptureSetting,
} from './diagnostic-settings'

describe('diagnostic capture setting', () => {
  it('defaults to disabled', () => {
    expect(DEFAULT_DIAGNOSTIC_CAPTURE_ENABLED).toBe(false)
    expect(readDiagnosticCaptureSetting({})).toBe(false)
  })

  it('enables capture only for an explicit boolean true', () => {
    expect(readDiagnosticCaptureSetting({ [DIAGNOSTIC_CAPTURE_STORAGE_KEY]: true })).toBe(
      true,
    )
    expect(readDiagnosticCaptureSetting({ [DIAGNOSTIC_CAPTURE_STORAGE_KEY]: 'true' })).toBe(
      false,
    )
  })
})
