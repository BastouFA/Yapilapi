import Link from 'next/link';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('safety');

/** Safety and minors: what the code does for people under 18 (apps/api: auth, visibility, messaging, family). A template. */
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
          Their content never appears without an account: not in link previews, search engines or our sitemap. Their reels can’t be downloaded, and they can’t
          be found by people who have their email address.
        </li>
        <li>Adults can only message a teen they are friends with. A guardian can limit messages further.</li>
        <li>Photos and videos marked sensitive, and posts waiting for a moderator, are not shown to them.</li>
        <li>They see no ads.</li>
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
        <li>Report posts, reels, profiles and messages from their menus. Reports are confidential.</li>
        <li>Block someone: they can’t see your profile or contact you, and you won’t see them.</li>
        <li>Mute people or topics in your feed, hide comments with words you choose, and choose who can tag you.</li>
        <li>Sign out devices you don’t recognise, and turn on two-step verification or a passkey.</li>
      </ul>

      <h2>Child sexual abuse material</h2>
      <p>
        We have zero tolerance. We remove it, keep what the law requires for investigators, end the accounts involved and report it to the authorities and to
        organisations that fight child sexual abuse, such as the National Center for Missing &amp; Exploited Children (NCMEC) [adjust for your country]. Report
        it in the app with “Minor safety”, or at <Mail to={c.safety} />.
      </p>

      <h2>If someone is in danger</h2>
      <p>
        Contact your local emergency services first. Then report the content in the app so we can act, or write to <Mail to={c.safety} />. [List helplines for
        the countries you launch in, for example crisis lines and child helplines.]
      </p>

      <h2>For law enforcement</h2>
      <p>
        Requests for information must come through valid legal process and be sent to <Mail to={c.safety} />. In an emergency involving a risk of death or
        serious injury, say so in the subject line. See also the <Link href="/legal/privacy">Privacy policy</Link>.
      </p>
    </LegalDoc>
  );
}
