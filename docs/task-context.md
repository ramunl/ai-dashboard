# Task context badges

The task card describes a captured context packet, separately from execution
admission checks. Capture age is shown as "Captured … ago" with a UTC timestamp
on hover; packet references and raw freshness/evidence fields are in expandable
Context details. The UI does not refresh observation timestamps or claim that
old context has been verified against current code.

Not-planned tasks show "Context not planned yet" ("Preparing context" during
planning). Missing metadata on completed tasks shows "Historical metadata
unavailable". Existing packets show "Context recorded", or "Historical context"
on completed tasks, instead of turning into warnings merely because they aged.
Nonzero omission/truncation counts still show an incomplete-context warning.
Changed/unavailable prerequisites retain warning labels; unknown prerequisites
say that checks are needed before the next run, rather than claiming a confirmed
blocker. Legacy snapshot status/reason fields remain supported.

The backend's fresh dependency verification and approval bindings still decide
whether work may start. Badge text never authorizes a run.
