import { defineManifest } from '@crxjs/vite-plugin'
import { hostMatchPatterns } from '../config/targets'

export default defineManifest({
  manifest_version: 3,
  name: 'Maltlock Side Panel Crawler',
  version: '0.1.0',
  description: '사이트별 수동 크롤링과 로컬 저장을 제공하는 Side Panel 확장',
  permissions: ['tabs', 'scripting', 'sidePanel', 'storage'],
  host_permissions: hostMatchPatterns,
  action: {
    default_title: 'Open Maltlock Side Panel',
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
