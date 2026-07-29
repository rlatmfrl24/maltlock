export const DIAGNOSTIC_CAPTURE_STORAGE_KEY = 'maltlock:capture-failure-payload'
export const DEFAULT_DIAGNOSTIC_CAPTURE_ENABLED = false

export function readDiagnosticCaptureSetting(
  stored: Record<string, unknown>,
): boolean {
  return stored[DIAGNOSTIC_CAPTURE_STORAGE_KEY] === true
}
