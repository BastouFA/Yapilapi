# REAL TOGETHER

Scope: `apps/api/src/modules/together`, migration `261_together.sql`. Tests: `apps/api/test/together.test.ts`.
Flag: `REAL_TOGETHER` (off means 404 `feature_disabled`).

A **shared experience** is a small, deliberate space where a few people who were somewhere together each add their own photos, Reals and notes.
It is a collaborative album with consent, not a feed: there is no ranking and nobody is added on anyone's behalf.

## Model

- **Experience**: title, description, optional place and linked event, visibility (`private` | `friends` | `public`), a lifecycle
  (open, closed, archived), and an optional collaborative cover.
- **Members**: `owner` (exactly one, enforced by a unique index), `contributor`, `viewer`. Status `invited`, `joined`, `declined` or `left`.
  Up to 50 members; a declined person cannot be re-invited for 30 days. Invites require an explicit accept, and blocked pairs cannot be invited.
- **Contributions**: a photo/video (the contributor's own media), one of their own Reals, or text. Up to 200 per member. A contribution belongs to
  its contributor; they (or the owner, for moderation) can remove it.
- **Cover**: members vote (`shared_experience_cover_votes`); the cover is chosen among contributions.
- **Profile**: a member can opt in to show the experience on their profile (`show_on_profile`, off by default).

## Visibility and moderation

- `experienceVisibleSql` decides who sees the experience: joined members, `friends` experiences to friends of the owner, `public` to everyone not
  blocked.
- **Per-contribution moderation** (`contributionVisibleSql`): a contribution is visible only if the experience is visible to the viewer and the
  contribution itself is approved. Text is screened like other user text; a held or removed contribution disappears for everyone but its author
  while the rest of the experience is unaffected (case type `experience_contribution`). Contribution media follows the same rule through the
  central media access check, so a file cannot leak through its URL.
- Blocks apply both ways. Accounts under 18 cannot make an experience public or contribute to a public one.

## Lifecycle

- `close`: no more contributions or invites (409); members can still read. `reopen` reverses it. `archive` hides it from the active list.
- Owner delete soft-deletes the experience.
- A member who leaves chooses whether to take their contributions with them or leave them.
- Account deletion (`releaseUserFromExperiences`): the person's contributions are withdrawn; if they owned an experience that other contributors
  still belong to, ownership passes to the longest-standing joined contributor, otherwise the experience is deleted.

## Export as each member's own memory

`POST /v1/together/:id/memory` creates a **private** memory for the caller holding a reference to the experience and the caller's **own**
approved contributions only (never other people's). It can be made once per experience (409 afterwards). Because MEMORY judges each item by its own
audience, exporting never widens anyone's privacy.

## Invite suggestions

`GET /v1/together/:id/suggested-invites` (owner) suggests attendees of the linked event, provided the owner attended, as provided by the events
module (blocks removed, people already members or recently declined excluded). It is a list only; the owner chooses.

## Endpoints

| Method               | Path                                             | Purpose                                     |
| -------------------- | ------------------------------------------------ | ------------------------------------------- |
| POST / GET           | `/v1/together`                                   | Create / list mine                          |
| GET / PATCH / DELETE | `/v1/together/:id`                               | Read / edit / delete                        |
| POST                 | `/v1/together/:id/{close,reopen,archive}`        | Lifecycle (owner)                           |
| POST                 | `/v1/together/:id/{accept,decline,leave}`        | Membership responses                        |
| GET / POST           | `/v1/together/:id/members`                       | List / invite                               |
| PATCH / DELETE       | `/v1/together/:id/members/:userId`               | Change role / remove                        |
| PUT                  | `/v1/together/:id/profile`                       | Opt in to show on my profile                |
| GET                  | `/v1/together/:id/suggested-invites`             | Invite suggestions from the linked event    |
| POST                 | `/v1/together/:id/contributions`                 | Add a contribution                          |
| GET                  | `/v1/together/:id/timeline`                      | Contributions in time order (keyset paging) |
| DELETE               | `/v1/together/:id/contributions/:contributionId` | Remove                                      |
| PUT                  | `/v1/together/:id/cover`                         | Vote for the cover                          |
| POST                 | `/v1/together/:id/memory`                        | Save my own copy as a memory                |
| GET                  | `/v1/users/:username/experiences`                | Experiences a person chose to show          |

## Known gaps

- No real-time co-presence ("everyone is here now"); intentionally not built.
- Contributions are not editable after posting (delete and re-add).
