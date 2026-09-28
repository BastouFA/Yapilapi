import Link from 'next/link';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('copyright');

/**
 * Copyright and takedowns: notice, counter-notice, repeat infringers and music licences
 * (docs/operations/music.md). Not legal advice: see docs/legal/review-pack.md and docs/legal/placeholders.md.
 */
export default async function CopyrightPage() {
  const c = await legalContacts();
  return (
    <LegalDoc slug="copyright">
      <p>
        Only share what you made or have permission to share. If you think something on YAPILAPI uses your work without permission, tell us and we will look at
        it quickly. You don’t need an account. If you have one, you can also use Report in the app and choose “Uses my work without permission”.
      </p>

      <h2>How to send a takedown notice</h2>
      <p>
        Email <Mail to={c.copyright} /> or write to our copyright agent at {c.entity}, {c.address}. [U.S. designated copyright agent, if you serve the United
        States.] Include:
      </p>
      <ol>
        <li>Your name, postal address, phone number and email address.</li>
        <li>The work you own, or a link to it.</li>
        <li>The link to each post, reel, story, profile, product, drop or other page on YAPILAPI that you want removed.</li>
        <li>A statement that you believe in good faith that the use is not authorised by you, your agent or the law.</li>
        <li>
          A statement that the information in your notice is accurate and, under penalty of perjury, that you are the owner or allowed to act for the owner.
        </li>
        <li>Your physical or electronic signature (typing your full name is enough).</li>
      </ol>
      <p>Sending a notice you know is false can make you liable for damages.</p>

      <h2>What happens next</h2>
      <p>We remove or disable the content, and tell the person who posted it, with a copy of your notice (we may remove your phone number and address).</p>

      <h2>Music</h2>
      <p>
        Music in the music picker comes from sources that license it for use on YAPILAPI: sounds people made here, Creative Commons music from Jamendo (only
        licences that allow it to be set to a video or photo; non-commercial ones only for personal accounts), and a licensing partner when one is connected.
        Each song shows the credit its licence asks for. We don’t copy or host the audio of catalogue songs: it plays from its source. If you think a song there
        is not licensed, tell us and we will check the licence with its provider. When a song is withdrawn or its licence ends, posts, stories and profiles that
        use it stay up but play without it.
      </p>

      <h2>If your content was removed</h2>
      <p>
        If you think it was a mistake or you have permission, send a counter-notice to <Mail to={c.copyright} /> with: your name, address, phone number and
        email; the content that was removed and where it was; a statement under penalty of perjury that you believe in good faith it was removed by mistake or
        misidentification; your consent to the jurisdiction of the courts [Counter-notice court jurisdiction] and to accept legal papers from the person who
        sent the notice; and your signature. Unless the person who sent the notice tells us within 10 to 14 business days that they have gone to court, we may
        put the content back.
      </p>

      <h2>Repeat infringement</h2>
      <p>We end the accounts of people who repeatedly share content that infringes others’ rights.</p>

      <h2>Trademarks and other rights</h2>
      <p>
        For trademarks, impersonation or privacy, write to <Mail to={c.copyright} /> with the same details, or use Report in the app. See also the{' '}
        <Link href="/legal/guidelines">Community guidelines</Link>.
      </p>
    </LegalDoc>
  );
}
