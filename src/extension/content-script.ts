import type {
  CollectHtmlRequest,
} from '../types/contracts'
import { collectHtml } from './collect-html'

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
  const request = message as CollectHtmlRequest | undefined

  if (!request || request.type !== 'COLLECT_HTML') {
    return false
  }

  sendResponse(collectHtml())
  return true
})
