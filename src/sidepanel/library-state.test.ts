// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { db } from '../db/schema'
import * as repository from '../db/repository'
import App from './App'

let host: HTMLDivElement
let root: Root

beforeEach(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
  vi.stubGlobal('requestIdleCallback', () => 1)
  vi.stubGlobal('cancelIdleCallback', () => {})
  await db.delete()
  await db.open()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } } })
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
  await db.delete()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('shows loading before distinguishing an empty saved library', async () => {
  let initial = ''
  await act(async () => {
    flushSync(() => root.render(createElement(App)))
    initial = host.textContent ?? ''
  })
  expect(initial).toContain('저장 결과를 불러오는 중')
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)) })
  expect(host.querySelector('#step-list')?.textContent).toContain('아직 저장된 항목이 없습니다.')
})

it('shows a saved-data error instead of calling a failed read empty', async () => {
  vi.spyOn(repository, 'listItemsBySite').mockRejectedValue(new Error('IndexedDB read failed'))
  await act(async () => { flushSync(() => root.render(createElement(App))) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)) })
  expect(host.querySelector('#step-list')?.textContent).toContain('저장 결과를 불러오지 못했습니다.')
  expect(host.querySelector('#step-list')?.textContent).not.toContain('아직 저장된 항목이 없습니다.')
})

it('returns to results when preparation is stopped before the runtime responds', async () => {
  vi.stubGlobal('chrome', { storage: { local: { get: async () => ({}) } },
    runtime: { sendMessage: () => new Promise(() => {}) },
  })
  await act(async () => { flushSync(() => root.render(createElement(App))) })
  const click = async (label: string) => {
    const button = Array.from(host.querySelectorAll('button')).find((element) => element.textContent === label)!
    await act(async () => button.click())
  }
  await click('크롤링')
  await click('크롤링 시작')
  await click('수집 중지')
  expect(host.querySelector('#step-list')?.hasAttribute('hidden')).toBe(false)
  expect(host.querySelector('[role="status"]')?.textContent).toContain('수집 중지')
})
