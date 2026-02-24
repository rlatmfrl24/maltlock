import type {
  RuntimeRequestMessage,
  RuntimeResponse,
} from '../types/contracts'

export async function sendRuntimeRequest<T>(
  message: RuntimeRequestMessage,
): Promise<RuntimeResponse<T>> {
  try {
    const response = (await chrome.runtime.sendMessage(message)) as
      | RuntimeResponse<T>
      | undefined

    if (!response) {
      return {
        ok: false,
        error: {
          code: 'UNKNOWN',
          message: '확장 응답을 받지 못했습니다.',
        },
      }
    }

    return response
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN',
        message:
          error instanceof Error
            ? error.message
            : '확장 메시지 전송 중 오류가 발생했습니다.',
      },
    }
  }
}
