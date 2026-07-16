# Milestone 04 authentic repair verification

Repair `c52183ec-2075-47e9-a1fb-7902e028dc42` was verified from a fresh detached worktree after the exact approved patch was reapplied by SHA-256. The candidate and verification worktrees were distinct, the patch was unchanged after verification, and cleanup completed after evidence was retained.

## OFF behavior

The repaired initialization-race journey passed the unchanged canonical evaluator. The single OFF run and each of five repeated OFF runs recorded zero identifiable activity requests and zero recommendation-service receipts. The UI, storage, and backend preferences were OFF after reload; the feed used three contextual recommendations; and every run recorded zero browser errors.

## Reload behavior

The OFF scenario observed a reload and passed the unchanged preference-survives-reload clause. This is evidence for the synthetic journey represented here, not a general claim about other products or environments.

## ON behavior

The single ON control and each of five repeated ON controls passed. Each recorded one identifiable activity request and one recommendation-service receipt, three behavioral recommendations, and zero browser errors. The repair therefore did not suppress behavioral activity or recommendations globally.

## Propagation-defect control

The independent propagation fixture remained intentionally broken. Its unchanged expected-red contract exited nonzero with only `PP_PREFERENCE_NOT_PERSISTED`; it recorded zero browser errors. Its ordinary green/control suite passed six tests. This distinguishes the repaired initialization race from the separate propagation defect.

## Verdict authority

The verification verdict is `pass` under the unchanged Playwright journey and deterministic evaluator. The Codex turn produced a bounded candidate, and the human approved its digest, but neither determined the pass verdict.
