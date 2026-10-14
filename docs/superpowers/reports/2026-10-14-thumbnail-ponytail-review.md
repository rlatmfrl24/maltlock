What this change does:

The recent thumbnail change loads images near the visible list and cancels requests that move away. It keeps a local image cache without waiting for each write before display. This review checks that change and the code that calls it, including item deletion.

Reviewed base: `b6005504dcaa4dd7c71076e80956db909b15fd6d` (PR #2 merge). There were no uncommitted changes when the review started. Scope: `CachedThumbnail`, thumbnail cache helpers, their App callers, tests, and README. Expected load: one user of a Chrome extension, up to 200 displayed rows and 500 cached images, with NimiWiki collecting 400 items.

Must fix:

1. **A deleted item is reported as a failed deletion** (`src/sidepanel/App.tsx:L558-580`, fixed).
   - **What this is:** Single-item deletion removes the database row, then removes its cached image.
   - **Problem:** If Cache Storage fails after the row is gone, the shared catch says deletion failed. It also runs the focus handling meant for a failed database deletion. Bulk deletion already treats image cleanup failure as a warning.
   - **Fix:** Keep database failures in the existing error path. Catch only image cleanup failure and report that the item was deleted, with a cache warning. Add a browser regression that checks stored rows, visible status, and the next keyboard target.
   - **If we skip it:** A user sees a failure after a completed deletion and cannot tell whether the item was removed.

Nice to have:

2. **Unused cache-clearing code** (`src/sidepanel/thumbnail-cache.ts:L102-106` at the reviewed base, removed).
   - **What this is:** `clearPersistentThumbnails` can erase the whole thumbnail cache.
   - **Problem:** No production code, test, or script in the repository calls it. It adds an unused data-deletion path to maintain.
   - **Fix:** Remove the six lines, including the separator. Keep the item-specific cache cleanup used by single and bulk deletion.
   - **If we skip it:** Users get no benefit, while later changes must still account for an unused function.

Verification:

- The new browser test failed on the base code after it confirmed the item was gone from IndexedDB. The visible status still said that deletion failed. This is in `review-red.log`.
- `pnpm.cmd check` passed type checks, ESLint, all 175 unit tests, and the production build. Final test-name editing was checked with ESLint again.
- Four related browser tests passed: failed-cache single deletion, sidepanel cache restoration, visibility and scroll cancellation, and the real NimiWiki saved-week route. The failure test injects a Cache Storage error in an isolated profile; it does not replace database deletion or UI orchestration.
- The real NimiWiki UI collected four platforms, saved 400 items with no expected API items missing, loaded the thumbnail, played the web video without a download, and deleted an item while retaining the seen log and keyboard focus. That run made one Bluesky thumbnail fetch and received no HTTP 428 responses.
- The preceding actual-source survey verified 283 thumbnails across KissJAV, 123AV, TwiDouga, and Kone on the base build. Those results are not presented as fresh runs of this deletion-status change. Tcafe remains excluded at the user's request.

Evidence: `C:/Users/rlatm/.codex/visualizations/2026/10/13/01a13738-5d44-7fd1-a9a6-9972defd84d5/other-site-thumbnails/`, especially `review-red.log`, `review-check.log`, and `review-green.log`.

Verdict: Ship.

Lean: -6 lines removed from production code. No new dependency, helper layer, or configuration was added.

Not checked: the full general browser suite was not rerun for this small change; the affected browser flows and full unit suite were run. Native storage exhaustion and several sidepanels writing at once were not induced. Actual database deletion failures still use the existing error path.
