import type { CollectHtmlResponse } from '../types/contracts'

// Standalone so Chrome can inject the same snapshot function without module dependencies.
export function collectHtml(): CollectHtmlResponse {
  const kissjav = document.querySelector('#list_videos_common_videos_list')
  return {
    html: document.documentElement.outerHTML,
    tabUrl: window.location.href,
    documentTitle: document.title,
    readyState: document.readyState,
    bodyTextLength: document.body?.innerText.length ?? 0,
    kissjavPage: Number(kissjav?.querySelector('#list_videos_common_videos_list_pagination a.active')?.textContent?.trim()) || undefined,
    kissjavReady: document.readyState === 'complete' &&
      !!kissjav?.querySelector('#list_videos_common_videos_list_items a[href*="/video/"]') && !kissjav.querySelector('.blockOverlay'),
  }
}
