import Link from 'next/link';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('safety');

/**
 * Safety and minors: what the code does for people under 18 (apps/api: auth, lib/users.ts
 * applyMinorDefaults, visibility, messaging, ask, rooms, boards, family). Not legal advice: see
 * docs/legal/review-pack.md, which also lists the gaps (for example lives).
 */
export default async function SafetyPage() {
  const c = await legalContacts();
  return (
    <LegalDoc slug="safety">
      <h2>Minimum age: 13</h2>
      <p>
        You must be at least 13 to use YAPILAPI, or older if the law where you live requires it. We ask for your date of birth when you sign up and refuse
        sign-ups under 13. If we learn that an account belongs to someone under 13, we delete it. Parents can tell us at <Mail to={c.safety} />.
      </p>

      <h2>How we protect teens (13 to 17)</h2>
      <ul>
        <li>Their accounts are private, and can’t be made public: only followers they approve see their posts.</li>
        <li>
          Their content never appears without an account: not in link previews, search engines or our sitemap. Their reels can’t be downloaded, their boards
          can’t be public, the city on their profile isn’t shown to others, and they can’t be found by people who have their email address.
        </li>
        <li>
          Adults can only message a teen, send them a question or invite them to speak in an audio room if they are friends. A guardian can limit messages
          further. Teens never receive questions asked without a name.
        </li>
        <li>In audio rooms, their connection goes through our relay server when one is set up, so other people don’t see their IP address.</li>
        <li>Photos and videos marked sensitive, and posts waiting for a moderator, are not shown to them.</li>
        <li>They see no ads, and ad personalization is off.</li>
        <li>Suggested replies in chats are off unless they turn them on.</li>
        <li>They can’t sell, take paid subscriptions, receive tips or ask for payouts.</li>
        <li>Reports about the safety of a minor hide the content right away while a moderator looks at it.</li>
      </ul>

      <h2>Family links</h2>
      <p>A parent or guardian aged 18 or over can link their account with a teen’s account.</p>
      <ul>
        <li>The guardian invites the teen by username in Settings, and the teen chooses whether to accept. A teen can have up to two guardians.</li>
        <li>
          The guardian can choose who can message the teen (friends and family, or family only), set a daily reminder, and set quiet hours when notifications
          wait.
        </li>
        <li>The guardian sees how many minutes the teen used YAPILAPI each day, and nothing else: never their messages, posts or who they talk to.</li>
        <li>The teen is told about every change, and either of them can end the link at any time.</li>
      </ul>

      <h2>Tools for everyone</h2>
      <ul>
        <li>
          Report posts, reels, stories, comments, profiles, messages, questions and answers, communities, audio rooms, lives, events, products and drops from
          their menus. Reports are confidential.
        </li>
        <li>
          Block someone: they can’t see your profile or contact you, and you won’t see them. For a question asked without a name, you can block whoever asked it
          without learning who they are.
        </li>
        <li>
          Choose who can message, comment on, mention and tag you, mute people or topics in your feed, hide comments and questions with words you choose, and
          set quiet hours for notifications.
        </li>
        <li>
          We tell you when your account is signed in from a new device. Sign out devices you don’t recognise, and turn on two-step verification or a passkey.
        </li>
      </ul>
      <p>
        A question asked without a name is not anonymous to us: we store who asked it, our moderators see it when they review a report, and limits and blocks
        apply to the person who asked.
      </p>

      <h2>Child sexual abuse material</h2>
      <p>
        We have zero tolerance. We remove it, keep what the law requires for investigators, end the accounts involved and report it to the authorities and to
        organisations that fight child sexual abuse, such as [Child safety reporting organisations, for example NCMEC]. Report it in the app with “Minor
        safety”, or at <Mail to={c.safety} />.
      </p>

      <h2>If someone is in danger</h2>
      <p>
        Contact your local emergency services first. Then report the content in the app so we can act, or write to <Mail to={c.safety} />. [Helplines for each
        launch country.]
      </p>

      <h2>For law enforcement</h2>
      <p>
        Requests for information must come through valid legal process and be sent to <Mail to={c.safety} />. In an emergency involving a risk of death or
        serious injury, say so in the subject line. See also the <Link href="/legal/privacy">Privacy policy</Link>.
      </p>
    </LegalDoc>
  );
}
