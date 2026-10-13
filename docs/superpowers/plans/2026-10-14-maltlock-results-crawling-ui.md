# Maltlock results/crawling implementation

Spec: docs/superpowers/specs/2026-10-14-maltlock-results-crawling-ui-design.md
Executor: superpowers:executing-plans, inline implementation.

## Global Constraints

- Preserve the five existing local changes captured in ae112de; no push or merge.
- Existing parsers, database contracts, privacy, thumbnail cache and deletion semantics remain authoritative.
- Primary entry: extension side panel, select site, crawling tab, start button; verify persisted results.
- New logic gets failing regression coverage first. No dependency or database migration.

## Task 1: Prepare and pin the crawl document

Interfaces: OPEN_TARGET_SITE returns OpenTargetSiteResult with documentId; automatic crawlers accept tabId/documentId. CANCEL_TARGET_SITE with requestId cancels pending preparation before late navigation (recorded safety ruling).

1. Add service-worker message tests proving open waits for a new ready document, rejects manual navigation and bounds blocked snapshots.
2. Run the tests; Expected: existing immediate response fails document readiness assertions.
3. Implement bounded navigation readiness using existing Chrome APIs and waitForSnapshot; preserve URL validation and protect user navigation.
4. Pass a fixed tabId to the automatic crawlers and adapt their unit callers. Keep existing document checks, page saves and cancellation.
5. Run pnpm test; Expected: whole unit suite passes. Commit scoped runtime changes.

## Task 2: Unify browsing and crawling with the library UI

Interfaces: shared activeSiteId; view is results or crawl; all terminal outcomes return to results; prepared tab metadata is passed to capture.

1. Add extension E2E coverage for local-only selection and one-click crawl with authoritative storage readback; run against the old UI to observe the failure.
2. Replace the three-step navigation with shared 3×2 site buttons and accessible two-tab navigation; default to results.
3. Connect navigation, readiness, single/automatic parsing and saving in one guarded lifecycle. Validate ranges before navigation and scope status to the selected site. Always return to results and focus its heading.
4. Apply the approved light library layout, large contained thumbnails, coherent type/spacing, error/empty/loading states, and short-panel scrolling. Keep result links and safe deletion.
5. Adapt E2E interactions to the new entry flow without weakening persistence, navigation, privacy, cache or partial-failure checks. Update user docs.
6. Run pnpm check and pnpm test:e2e; Expected: unit, static, build and E2E checks pass. Commit scoped UI/tests/docs.

## Task 3: Review, verify real use and deliver

1. Execute existing live NimiWiki flow through the start button and inspect results and persisted items/runs; inspect representative viewport screenshots.
2. Dispatch one fresh whole-change reviewer using the approved spec and baseline ae112de. Fix critical/important findings with failing regressions; record rulings and deferred minor findings.
3. Run the final affected checks; Expected: all necessary verification is green, with precise live-site limits reported if present.
4. Confirm original files still match their recorded hashes, then deliver the final tracked files back to C:/Develop/maltlock and build its dist. Do not overwrite concurrent changes.
5. Preserve review evidence in the plan, remove only this plan's scratch directory after path verification, and report actual outcomes and remaining limits.

## Review Focus

- Moving between preparation and automatic crawling must not switch to the newly active browser tab or overwrite manual navigation.
- Same-URL reloads cannot capture an old document; hung snapshots must have a deadline.
- Ending with only duplicates, partial saves, cancellation or errors must show accurate cumulative results without claiming new data.
- Existing local NimiWiki video-link and thumbnail-layout changes must survive delivery.

## Execution evidence

Tasks 1 and 2 were delivered atomically in cfcb997 to keep the required document metadata and its UI consumer consistent. A fresh whole-change review found one important hash-navigation defect and no critical/minor findings. The one fix pass in 8a5ac32 proves a new document for hash addition, change and identical-URL retry.

Final check: 25 unit files / 155 tests, TypeScript, ESLint and build pass. Full regular E2E on cfcb997: 18 pass. The affected navigation/stop/timeout subset passed after the first review fix; final 8a5ac32 start/hash E2E: 2 pass. Final live NimiWiki start-button flow: 400 saved items, 4 successful persisted runs, API-to-storage missing items 0, actual thumbnail/viewer playback and safe deletion pass.

Tasks 1–3 are complete. All 19 final files were delivered to C:/Develop/maltlock after checking the five original modification hashes. Its build passes; 17 runtime artifacts match the tested build exactly, with three nonmaterial metadata/whitespace differences inspected separately. Existing nimi.ts/nimi.test.ts changes retain their original hashes. The local branch/worktree is kept for recovery under the accepted no-push/no-merge delivery plan.

Rulings, review details and precise artifact/verification limits: [implementation report](../reports/2026-10-14-maltlock-results-crawling-ui.md).
