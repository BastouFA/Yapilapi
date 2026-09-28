import Link from 'next/link';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('cookies');

/**
 * Cookie notice: the session cookie (packages/auth, SESSION_COOKIE), the browser storage keys the
 * web app uses (apps/web: lib/theme.ts, lib/data-saver.ts, components/UsageHeartbeat.tsx,
 * WeeklyWrap.tsx, SuggestedPeople.tsx, Yap.tsx, reels, search, stories, live), what the phone app
 * keeps (apps/mobile, SecureStore keys) and the third parties the website loads. Update it when
 * any of these change. Not legal advice: see docs/legal/review-pack.md.
 */
export default async function CookiesPage() {
  const c = await legalContacts();
  return (
    <LegalDoc slug="cookies">
      <h2>The one cookie we set</h2>
      <table className="legal-table">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">What it does</th>
            <th scope="col">How long</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>ypl_session</code>
            </td>
            <td>Keeps you signed in. It can’t be read by scripts on the page and is only sent to YAPILAPI. The website doesn’t work signed in without it.</td>
            <td>30 days, or until you sign out</td>
          </tr>
        </tbody>
      </table>
      <p>We don’t use advertising or analytics cookies, and no other company sets cookies through our pages, except as described below.</p>

      <h2>What the website keeps in your browser</h2>
      <p>
        These are stored only in your browser (its local or session storage), are never sent to us by themselves, and you can clear them in your browser
        settings at any time. They only remember choices you make on the website and where you are in it; none of them is used for advertising or to follow you
        on other websites.
      </p>
      <ul>
        <li>
          Your light or dark appearance choice, when you chose one other than your system’s, and your language while you are signed in, so pages open in it.
        </li>
        <li>Your Data saver choice for this browser, your Reels sound and caption preferences, and whether you have hidden people suggestions.</li>
        <li>Your recent searches and recently used story music, so you can find them again.</li>
        <li>Whether Yaps are on, and whether you put away today’s “On this day” card.</li>
        <li>
          For the minutes you use YAPILAPI each day: the time of the last count in this tab, so a minute is counted once, and whether today’s break reminder was
          already shown.
        </li>
        <li>While you are live: the stream details for this tab, so a reload doesn’t end the stream.</li>
      </ul>

      <h2>Other companies</h2>
      <ul>
        <li>The website’s fonts are served by YAPILAPI itself, so opening a page sends nothing to Google or any other font service.</li>
        <li>
          At checkout, Stripe’s payment form loads from Stripe, which may set its own cookies to prevent fraud (see Stripe’s privacy policy). Nothing from
          Stripe loads anywhere else. Paystack checkout opens on Paystack’s own page, under its own cookie rules.
        </li>
        <li>
          When you press play on a song from a music catalogue, your browser loads it from that catalogue’s own address (for example Jamendo), which sees your
          IP address. Nothing loads before you press play.
        </li>
        <li>
          Mini apps open inside a sealed frame loaded from the address of the developer who made them, so that developer sees your IP address. The frame can’t
          read our cookie or anything the website keeps in your browser.
        </li>
      </ul>

      <h2>In the phone app</h2>
      <p>
        The app has no cookies. It keeps in your phone’s secure storage: your sign-in (for up to five accounts if you use account switching), the token that
        lets us send you notifications, and a few preferences (appearance, Data saver, Reels sound, recent searches, story music, whether you have seen the
        tour, the break reminder and the “On this day” card).
      </p>

      <h2>More</h2>
      <p>
        See the <Link href="/legal/privacy">Privacy policy</Link>, or write to <Mail to={c.privacy} />.
      </p>
    </LegalDoc>
  );
}
