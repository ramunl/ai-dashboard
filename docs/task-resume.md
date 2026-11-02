# Interrupted implementation

The Tasks page distinguishes two owner-confirmed actions:

- **Resume with …** sends `resume_task`. It is offered only when the agent
  explicitly publishes `can_resume: true`, and starts a new AI run from the saved branch and edits. It does not restore the
  previous provider conversation.
- **Start fresh with …** sends the existing `retry_task`. Its confirmation
  explains that the approved plan restarts from a clean checkout while saved
  work remains preserved.

When no safe checkpoint is available, Resume is disabled. The agent's
`resume_reason` is shown so an old recovery reference is not mistaken for an
available continuation. Optional `resume_summary` describes eligible saved work.
The agent revalidates eligibility when executing the request; a page snapshot
is not authorization to restore arbitrary refs.

Pending plans may publish `scope_assessment` with `recommend_split`, `reason`,
and `milestones` (title and acceptance). A recommendation appears before
approval with the suggested independently testable milestones. **Revise** lets
the owner narrow the plan; displaying advice never sends a paid action. The
existing **Split into tasks** action remains specific to repository splitting.

Direct bugfixes may publish `pending_scope_assessment` beside `pending_branch`.
The same warning appears before confirmation, with instructions to cancel and
plan one milestone; no revision action is offered without a pending plan.
