# Trust and safety

Scope: `packages/moderation`, `apps/api/src/modules/safety`, `apps/api/src/lib/{moderation-hook,safety-signals}.ts`, the staff RBAC in
`apps/api/src/modules/admin/rbac.ts`, migration `190_safety.sql`. Tests: `apps/api/test/safety.test.ts`, `packages/moderation/src/safety-logic.test.ts`.

## Principles

- **Reduce harm first, then be fair.** Automation may only _restrict and queue_; it never bans. Every permanent action (ban, escalated
  case, account-level decisions on serious categories) needs a human with the right role.
- **Nothing is invisible to the person it affects.** Anyone subject to a decision sees what was done, why (category, not who reported),
  and how to appeal.
- **Reporters are protected.** A subject can never learn who reported them: notifications and responses carry no reporter id, and report
  the outcome shown to the reporter is coarse (`received`, `under_review`, `action_taken`, `no_violation_found`) without the enforcement.
- **Teens get more protection, never less**: stricter defaults, no third-party apps, no personalised ads, guardian links they control.
- **Least data.** Moderators see an evidence snapshot frozen at report time (so later edits cannot erase it), not the whole account. Private
  messages are reachable only as evidence attached to a report, never through search or lookup.

## Flow

1. **Detect.** Three sources create or feed a _moderation case_ (`moderation_cases`, one open case per target):
   - **Reports** (`POST /v1/reports`): 13 reasons, each mapped to a category and base risk (`REASON_PROFILE`). Duplicate reports by the
     same person for the same reason are ignored. Three distinct reporters raise the case to _high_, ten to _critical_; risk only ever goes up.
     The reporter must be able to _see_ the target (central visibility predicates); otherwise the answer is 404, so reporting cannot be used to probe private content.
   - **Automated text screening** (`lib/moderation-hook.ts`): risky text is restricted or queued at creation, in the same transaction.
   - **Behaviour signals** (`lib/safety-signals.ts`, pure scoring in `packages/moderation/src/spam.ts`): post/comment/message velocity,
     duplicate content (normalised), link stuffing, mass following (>40 follows/hour suspicious, >80 strong), new-account weighting.
     Score >= 40 opens a _review_ case; >= 70 restricts the content and opens a _restricted_ case. Following is never blocked, the case is a review.
   - **Impersonation** (`safety/impersonation.ts`, pure logic in `packages/moderation/src/impersonation.ts`): lookalikes of verified businesses,
     verified creators, staff and reserved names (homoglyph skeleton + edit distance + embedded-name rule). It only opens a case.
2. **Review.** Staff work `/v1/staff/moderation/*`: queue stats, filterable keyset-paginated case list, claim/release, escalate, decide.
   A claim is exclusive; two moderators cannot decide the same case.
3. **Decide.** Decisions: `no_action`, `label`, `limit_reach`, `remove`, `suspend_user`, `ban_user`. Each decision needs a written reason,
   is written to the case timeline and the audit log, and applies its _effects_ atomically: content status change, enforcement row, session
   revocation, notification. A `no_action` on an automated restriction releases the content.
4. **Appeal.** The person can appeal within 14 days (`APPEAL_WINDOW_DAYS`), once per case, from the app (`POST /v1/appeals`) or, if they
   can no longer sign in, through a personal link emailed with the suspension (only its SHA-256 is stored; an appeal is accepted once per case).
   **Reviewer separation:** the appeal reviewer must differ from the original decider (`appeals.original_decider_id`) and from the appellant, enforced in code and covered by tests;
   appeals of bans can only be reviewed by admins. An overturned appeal reverses the effects: content is restored, the case's enforcements are revoked (so their strike points stop counting), the account is reinstated if nothing else blocks it, and the reports are marked dismissed.
5. **Expire.** `scripts/expire-enforcements.ts` (every 5 minutes) reinstates accounts whose time-limited suspension has ended.

## Strikes

Points are per _upheld_ decision by severity (low 1, medium 1, high 2, critical 3) and decay: only points from the last 90 days count.
The ladder recommends an action from the total: 1 warning, 2 reach limit (3 days), 3 suspension (3 days), 5 suspension (14 days), 7 ban.
Categories with _immediate_ handling skip ahead: minor safety (30-day suspension) and threats (14 days). The ladder is a **recommendation shown to
the moderator**; `ban` is `humanOnly`. Everything is in `DEFAULT_STRIKE_POLICY` and unit tested.

## Enforcement effects (what "suspended" means)

- `applySuspension` (single implementation, also used by the admin console) writes the enforcement, sets `users.status = suspended`, revokes **all** sessions,
  OAuth tokens and realtime tickets, and returns the appeal token. Login returns 403 while suspended; the API rejects any old session immediately.
- Restrictions (`limit_reach`, content `restricted`) reduce distribution but leave the account usable.
- Ending the suspension (expiry, appeal, admin reactivation) goes through `reinstateIfClear`: the account only becomes active again if no other active suspension or ban remains.

## Roles (RBAC)

One permission matrix (`admin/rbac.ts`) is the single source of truth; every staff route is declared with `adminRoute(permission, ...)`, which
derives the allowed roles from it and relies on the route helper for MFA enforcement (staff without MFA are refused with 403).

| Role       | Adds                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| support    | read users (email masked), notes, content lookup, reports and cases (read), payments overview                                                                 |
| moderator  | decide cases, review appeals, suspend users/communities                                                                                                       |
| admin      | unmasked PII (audited), reactivate, escalated cases and bans, business/creator actions, fraud/AI/audit/system read, feature flags, analytics, mini-app review |
| superadmin | change platform roles                                                                                                                                         |

Rank rules: nobody acts on their own account; a moderator cannot act on staff of equal or higher rank (answered with 404 so lower staff cannot map the hierarchy).
Role changes require MFA on the target, an adult account, end all of the target's sessions and are audited with before/after.

## Guardians

A teen invites an adult (max 3). The adult accepts; either side can revoke at any time. An active guardian sees the teen's safety settings and an
enforcement summary. **Never content**: the summary query selects a fixed column list and the tests assert that message text is absent.

## Support resources

`GET /v1/safety/resources?region=US` is public and curated. Regions we have not reviewed return no hotline numbers, only international directories,
and the response carries `reviewStatus: needs_regional_review`. Self-harm reports send the _subject_ support resources (never the reporter's identity).

## Audit

Sensitive actions write `audit_logs` (append-only at the database level, metadata redacted): case claim/decision/escalation, appeal review, suspensions,
role changes, user/PII views, note additions, guardian changes. Consent and moderation records survive account deletion (pseudonymous ids only), see `privacy.md`.

## Endpoints

User: `POST /v1/reports`, `GET /v1/reports/mine`, `GET /v1/safety/enforcements`, `POST /v1/appeals`, `GET /v1/appeals/mine`, `GET /v1/safety/resources`,
guardians (`/v1/safety/guardians*`, `/v1/safety/guardian/minors/:id/summary`).
Staff: `/v1/staff/moderation/{queue-stats,cases,cases/:id,cases/:id/claim|release|escalate|decision,impersonation-check,appeals,appeals/:id/review}`,
`/v1/admin/{cases,cases/:id,reports}` (read overviews).

## Known gaps

- Text classification is rule-based (`classifyText`); there is no image/video/audio classifier and no hash-matching for known illegal media. Media
  reports reach humans but are not pre-screened.
- Regional support resources are only reviewed for a few regions; everything else needs local review before launch.
- No SLA timers or on-call routing for critical cases (queue stats show oldest open case age; alerting must be added in ops).
- Appeals are one round; there is no external/independent review step.
- Strike ladder parameters are code constants, not editable through the console.
- Coordinated-abuse detection (many accounts, one campaign) is not implemented; only per-account signals.
