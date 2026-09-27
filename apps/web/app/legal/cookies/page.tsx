import Link from 'next/link';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('cookies');

/**
 * Cookie notice: the session cookie (packages/auth, SESSION_COOKIE), the browser storage keys the
 * web app uses, and the third parties the website loads. Update it when any of these change.
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
      <p>These are stored only in your browser, are never sent to us by themselves, and you can clear them in your browser settings at any time.</p>
      <ul>
        <li>Your Data saver choice for this browser, your Reels sound and caption preferences, and whether you have hidden people suggestions.</li>
        <li>Your recent searches and recently used story music, so you can find them again.</li>
        <li>Whether Yaps are on, and whether today’s break reminder was already shown.</li>
        <li>While you are live: the stream details for this tab, so a reload doesn’t end the stream.</li>
      </ul>

      <h2>Other companies</h2>
      <ul>
        <li>The website loads its fonts from Google Fonts, so Google receives your IP address when you open a page.</li>
        <li>
          At checkout, Stripe’s payment form loads from Stripe, which may set its own cookies to prevent fraud (see Stripe’s privacy policy). Nothing from
          Stripe loads anywhere else.
        </li>
      </ul>

      <h2>In the phone app</h2>
      <p>
        The app has no cookies. It keeps your sign-in and a few preferences (Data saver, recent searches, whether you have seen the tour) in your phone’s secure
        storage.
      </p>

      <h2>More</h2>
      <p>
        See the <Link href="/legal/privacy">Privacy policy</Link>, or write to <Mail to={c.privacy} />.
      </p>
    </LegalDoc>
  );
}
