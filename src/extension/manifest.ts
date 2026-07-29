import { defineManifest } from '@crxjs/vite-plugin'
import { hostMatchPatterns } from '../config/targets'

const privacyBlurHostPermissions = ['http://*/*', 'https://*/*']
const extensionIcons = {
  16: 'icons/maltlock-16.png',
  32: 'icons/maltlock-32.png',
  48: 'icons/maltlock-48.png',
  128: 'icons/maltlock-128.png',
}

export default defineManifest({
  manifest_version: 3,
  name: 'Maltlock Side Panel Crawler',
  version: '0.1.0',
  description: '사이트별 수동 크롤링과 로컬 저장을 제공하는 Side Panel 확장',
  icons: extensionIcons,
  permissions: ['tabs', 'scripting', 'sidePanel', 'storage', 'activeTab'],
  host_permissions: Array.from(
    new Set([...hostMatchPatterns, ...privacyBlurHostPermissions]),
  ),
  action: {
    default_title: 'Open Maltlock Side Panel',
    default_icon: extensionIcons,
  },
  background: {
    service_worker: 'src/extension/service-worker.ts',
    type: 'module',
  },
  side_panel: {
    default_path: 'sidepanel.html',
  },
  content_scripts: [
    {
      matches: hostMatchPatterns,
      js: ['src/extension/content-script.ts'],
      run_at: 'document_idle',
    },
  ],
})
