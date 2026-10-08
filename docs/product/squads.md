# Squads

A squad is a small private group of friends inside YAPILAPI: up to 10 people (`MAX_SQUAD_MEMBERS`) with a shared feed, one shared story, a group chat and a weekly memory. Nobody outside a squad learns that it exists, who is in it or what is shared in it.

Behind the `SQUADS` flag (on by default). Migration `0086_squads.sql`. Code: `apps/api/src/lib/squads.ts`, `apps/api/src/modules/squads.ts`, `packages/shared/src/squads.ts` (types and notification text, no zod, for the phone) and `squad-schemas.ts`. Web: `/squads`, `/squads/[id]` (`apps/web/components/Squads.tsx`). Phone: `app/squads.tsx`, `app/squad/[id].tsx` (`lib/squads.tsx`). Tests: `apps/api/test/squads.test.ts`.

## Why a new thing, and what it reuses

Before building, we looked at what already holds groups of people:

| Feature           | Who owns it                                  | Who sees it                                                         | Why it isn't a squad                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Circles           | One person                                   | Only the owner; members are never told they're in one               | An audience list, not a place. Members can't see each other or share back to it.                                                                                                                                         |
| Close friends     | One person                                   | Only the owner                                                      | The same, for stories.                                                                                                                                                                                                   |
| Group chats       | The people in it                             | The people in it                                                    | Chat only; anyone in it adds people without asking them.                                                                                                                                                                 |
| Communities       | An owner and a role ladder                   | Public ones to everyone; private ones are still listed and searched | Built for interests and strangers: discovery, slugs, rules, bans, rooms. A private community's name and member count are visible to anyone, and joining is by asking, not by invite. Community posts stay in the community. |
| Together albums   | A creator                                    | Members                                                             | Photos of one event, for a while.                                                                                                                                                                                        |

A squad is the missing middle: a space its members share (unlike a circle), kept invisible to everyone else (unlike a community), joined only by accepting an invite from someone you know (unlike a group chat). Making it a kind of community would have meant switching off most of what communities are (discovery, roles, rooms, public pages) and adding the opposite of their rules, so it is its own small table that reuses the existing machinery instead:

- **Audience**: a new visibility, `'squad'` (with `posts.squad_id` and `moments.squad_id`), checked in the one place every read already goes through: `postVisibleSql` and `storyVisibleSql` (`squadMemberSql` in `lib/visibility.ts`). Feeds, search, profiles, the post page, comments, mentions, reports and exports all follow it without code of their own.
- **Chat**: an ordinary group conversation (`squads.conversation_id`), so it shows in the inbox and in the Yap app. Its members follow the squad's.
- **Story**: ordinary stories with the `'squad'` visibility, grouped into one ring for the squad.
- **Pass the Mic**: ordinary chains with a `squad_id`.
- **Notifications**: `notify()` with the `friends` category (settings, pauses, quiet hours, blocks and mutes apply), batched with its `group`.
- **Weekly memory**: a small card made by the job worker's minute loop, like the weekly wrap.

Circles stay as they are: private audience lists you own. A squad is a shared space its members own together.

## Rules

**Making one.** A name (1 to 40 characters), a cover colour (one of `SQUAD_COLORS`, named like the profile accents; white text on each is at least 4.5:1) or a cover photo (one of your own processed photos, never blocked or sensitive), and 2 to 9 people to invite (`SQUAD_RULES.minInvites` to `MAX_SQUAD_MEMBERS - 1`). Invites count towards the 10, so a squad never goes over. Someone is in or invited to at most `SQUAD_RULES.maxSquads` (20) squads. 10 new squads an hour.

**Who can be invited.** Anyone in the squad can invite (30 invites an hour). The person must be a friend of the inviter, or follow them and be followed back (private accounts have approved that follow). And with everyone already in the squad, because everyone in it is in its chat:

- no block either way (the group-chat rule);
- an adult and someone under 18 only when they are friends or family-linked (the group-chat minor-safety rule), so teens are in squads with teens, or with adults who are their friends;
- a supervised teen's family settings for messages apply both ways.

The whole invite is refused with the first reason. Accepting checks the same against who is in the squad then; declining just removes the invite, and nobody is told.

**Roles.** One owner. The owner makes members admins and back, hands the squad on (staying as an admin) and deletes it. The owner and admins rename it, change its cover and remove people (admins only members); anyone can leave except the owner, who hands it on first. The squad's owner and admins are its chat's admins.

**Sharing.** In Create, on the web and the phone, each squad you're in is an audience ("Squad: Crew") for posts, reels and stories. A squad's post:

- reaches only its members, wherever posts show (their feeds, the squad page, the post page, search for them), labelled with the squad;
- has comments seen by members only (anyone who can see the post can comment, as the author chooses);
- never opens up: its audience can't be changed later, it can't be reposted, remixed, echoed or boosted (those need public posts), and co-authors aren't offered;
- stays with the squad when its author leaves (they can delete it), and with its author alone when the squad is deleted.

The members who aren't the author are told, batched per squad while unread ("Ada and 2 others shared in Crew").

**The squad's story.** Stories shared to the squad last 24 hours (`SQUAD_RULES.storyHours`, whatever was asked), are seen by members only, can't be reshared, and show as one ring with the squad's cover, right after your own ring. Each story in the ring says whose it is; your own have your usual tools (seen by, delete).

**The chat.** Made with the squad. Who is in it follows the squad: joining adds you, leaving or being removed takes you out (live locations and games stop as in any group), renaming the squad renames it, and lines say so. The chat's own add, remove, admin, rename and leave are refused for a squad's chat (`squad_chat`): those happen on the squad. When a squad is deleted its chat stays an ordinary group for the people in it.

**Weekly memory.** On Monday (UTC) the job worker looks back at the squad's Monday to Sunday. A squad that shared something gets "Your squad's week": how many posts, reels and stories, who shared, and the 3 most liked and commented moments. It is made once (`UNIQUE (squad_id, week_start)`, safe on every instance), each member gets one notification, and it is pinned on the squad page until the next one. Posts in it are read back through the visibility rules each time. A quiet week makes nothing.

**Pass the Mic.** A reel shared with a squad can start a chain; that chain is the squad's (`reel_chains.squad_id`): only members see it and take the mic, with reels shared to that squad. It isn't on Wander's Chains shelf. Deleting the squad deletes its chains (their reels stay with their authors).

**Notifications.** `squad_invite`, `squad_joined`, `squad_post` (batched) and `squad_memory`, all in the `friends` category, entity `squad`. They open the squad. Leaving, being removed or the squad being deleted removes them from your list.

## Privacy and safety

- Every squad endpoint answers "not found" to anyone not in the squad or invited to it. Someone invited sees who is in it (not who else is invited) and who invited them.
- Member lists leave out people blocked either way.
- Your data export lists the squads you're in or were invited to (name, your role, dates), never the other people in them.
- Reports on squad posts, comments and stories go through the usual reports and moderation queue: members can report what they see. The admin console shows how many squads, people, open invites and posts this week (under Feature flags).
- Deleting an account hands each squad it owned to its longest-standing admin (or member), or deletes it when nobody else is in it.

## API

`GET/POST /v1/squads`, `GET /v1/squads/candidates`, `GET/PATCH/DELETE /v1/squads/:id`, `POST /v1/squads/:id/{invites,accept,decline,leave,owner}`, `DELETE /v1/squads/:id/members/:userId`, `PUT /v1/squads/:id/members/:userId/role`, `GET /v1/squads/:id/posts`, `GET /v1/squads/:id/memories/:memoryId`, `GET /v1/admin/squads`. Sharing: `POST /v1/posts` and `POST /v1/moments` with `visibility: 'squad', squadId`.

## Not yet

- A squad's own page for its stories and memories over past weeks (only this week's memory is pinned).
- Squad screens in the Yap app (its chat is there, as any group).
