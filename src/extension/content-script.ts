import type {
  CollectHtmlRequest,
  CollectHtmlResponse,
} from '../types/contracts'

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as CollectHtmlRequest | undefined

  if (!request || request.type !== 'COLLECT_HTML') {
    return false
  }

  const response: CollectHtmlResponse = {
    html: document.documentElement.outerHTML,
    tabUrl: window.location.href,
  }

  sendResponse(response)
  return true
})
