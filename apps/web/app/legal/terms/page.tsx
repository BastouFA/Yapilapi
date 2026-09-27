import Link from 'next/link';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('terms');

/** Terms of service. A template: a lawyer must review it before launch (docs/operations/app-store.md). */
export default async function TermsPage() {
  const c = await legalContacts();
  return (
    <LegalDoc slug="terms">
      <p>
        These terms are an agreement between you and {c.entity} (“YAPILAPI”, “we”, “us”), {c.address}. They apply when you use the YAPILAPI app, the website and
        anything else we offer under the YAPILAPI name (together, “YAPILAPI”). By creating an account or using YAPILAPI, you accept them. If you don’t accept
        them, don’t use YAPILAPI.
      </p>
      <p>
        These policies are part of the terms: the <Link href="/legal/privacy">Privacy policy</Link>, the{' '}
        <Link href="/legal/guidelines">Community guidelines</Link>,<Link href="/legal/safety"> Safety and minors</Link>, the{' '}
        <Link href="/legal/creators">Creator and seller terms</Link> (if you sell, take subscriptions or receive tips),{' '}
        <Link href="/legal/copyright">Copyright and takedowns</Link> and the <Link href="/legal/cookies">Cookie notice</Link>.
      </p>

      <h2>1. Who can use YAPILAPI</h2>
      <ul>
        <li>
          You must be at least 13 years old, or older if the law where you live sets a higher age for using a service like this without a parent’s consent.
        </li>
        <li>If you are under 18, you confirm that a parent or guardian has agreed to these terms where the law requires it.</li>
        <li>You can’t use YAPILAPI if the law or a previous decision by us forbids it, for example if we removed your account for breaking these terms.</li>
        <li>Give accurate information when you sign up, including your date of birth, and keep it up to date.</li>
      </ul>

      <h2>2. Your account</h2>
      <p>
        Keep your password safe and don’t share your account. You are responsible for what happens on it. You can turn on two-step verification and passkeys in
        Settings, and see and sign out the devices signed in to your account. Tell us at <Mail to={c.support} /> if you think someone else is using it.
      </p>

      <h2>3. Your content</h2>
      <p>
        You own what you post: posts, reels, stories, comments, messages, photos, videos, sounds, events, products and everything else you share (“your
        content”). You are responsible for it and must have the rights to share it.
      </p>
      <p>
        To run YAPILAPI we need a licence to it. You give us a worldwide, non-exclusive, royalty-free licence to host, store, copy, show, share, adapt (for
        example resize, convert, caption or translate) and distribute your content, only to operate, protect and improve YAPILAPI and to show your content to
        the people you chose. The licence ends when you delete the content or your account, except for copies other people shared in the ways YAPILAPI allows
        (for example a repost or a remix you allowed), copies kept for legal or safety reasons, and backups, which are replaced within 30 days.
      </p>
      <p>
        Who sees your content depends on the audience you choose. Content you share with everyone from a public account of someone 18 or older can appear in
        link previews, without an account, and in search engines.
      </p>

      <h2>4. What you may not do</h2>
      <ul>
        <li>
          Break the <Link href="/legal/guidelines">Community guidelines</Link> or the law.
        </li>
        <li>Share content that infringes someone else’s rights, including copyright, trademarks and privacy.</li>
        <li>
          Access or collect data from YAPILAPI by automated means (bots, scrapers, crawlers) other than through our developer platform and within its limits, or
          except as allowed by our robots.txt file for search engines.
        </li>
        <li>
          Try to get around limits, blocks, age protections, regional rules or security measures, or probe, scan or test our systems without our permission.
        </li>
        <li>Interfere with YAPILAPI or other people’s use of it, including spam, fake accounts and fake engagement.</li>
        <li>Sell, rent or transfer your account, usernames or access.</li>
        <li>Misuse reports or appeals, for example by reporting people in bad faith.</li>
      </ul>

      <h2>5. How we moderate</h2>
      <p>
        We use automated tools and people to find content and behaviour that break these terms. We may remove or restrict content, hold it for review, withhold
        it in a country where the law requires it, limit features, or suspend or end accounts. When we act on your content or account we tell you why, in the
        app, and you can appeal from Settings. We may also report content to the authorities where the law requires it, for example child sexual abuse material.
      </p>

      <h2>6. AI features</h2>
      <p>
        Some features use artificial intelligence: caption and plan suggestions, summaries, search, the assistants, “See translation” and automatic captions.
        They are optional. What they produce can be wrong, so check it before you rely on it or post it; you are responsible for what you post. Posts made with
        AI help can be labelled as such. The <Link href="/legal/privacy">Privacy policy</Link> says what is sent to the companies that provide these features.
      </p>

      <h2>7. Paid features</h2>
      <ul>
        <li>
          Prices are shown before you pay. Payments are processed by our payment providers (Stripe, and Paystack in some countries); we never see your full card
          number.
        </li>
        <li>YAPILAPI Plus costs the price shown for 30 days and does not renew on its own.</li>
        <li>
          Buying from creators, businesses and sellers (products, tickets, bookings, downloads, subscriptions and tips) is also covered by the{' '}
          <Link href="/legal/creators">Creator and seller terms</Link>. The seller is responsible for what they sell.
        </li>
        <li>Refunds follow the law where you live and the rules in the Creator and seller terms. Your statutory rights as a consumer are not affected.</li>
      </ul>

      <h2>8. Other people’s services</h2>
      <p>
        YAPILAPI can link to or include things made by others: apps you connect with “Sign in with YAPILAPI”, mini apps, music from licensed catalogues, and
        links to maps and websites. Their own terms apply to them, and we aren’t responsible for them. You choose what a connected app can access and can remove
        it in Settings.
      </p>

      <h2>9. Our rights</h2>
      <p>
        YAPILAPI, its name, logo, design and software belong to us or our licensors. These terms don’t give you any right to use them except to use YAPILAPI as
        intended. If you send us feedback or ideas, we may use them without owing you anything.
      </p>

      <h2>10. Disclaimers</h2>
      <p>
        We work to keep YAPILAPI available, safe and accurate, but we provide it “as is” and can’t promise it will always be available or free of errors. We
        don’t control what people post and are not responsible for it. Nothing in these terms excludes rights or liability that the law doesn’t allow us to
        exclude.
      </p>

      <h2>11. Limits on liability</h2>
      <p>
        To the extent the law allows, we are not liable for indirect or unforeseeable losses, lost profits or lost data, and our total liability to you for any
        claim is limited to the greater of the amount you paid us in the 12 months before the claim and 100 US dollars. This doesn’t limit liability for death
        or personal injury caused by negligence, for fraud, or anything else the law doesn’t allow us to limit.
      </p>

      <h2>12. Ending your use</h2>
      <p>
        You can stop using YAPILAPI at any time and delete your account in Settings, on the web (Settings, Privacy, Delete my account) or in the app (Settings,
        Your data). We may suspend or end your access if you break these terms or the law, or if we have to by law, and we tell you unless doing so would be
        unsafe or unlawful. Sections 3 (for content already shared), 9, 10, 11 and 14 continue after your account ends.
      </p>

      <h2>13. Changes</h2>
      <p>
        We may change these terms, for example when we add features or the law changes. If a change matters, we tell you in the app or by email before it takes
        effect. If you keep using YAPILAPI after that, you accept the new terms; if you don’t accept them, you can delete your account.
      </p>

      <h2>14. Law and disputes</h2>
      <p>
        These terms are governed by {c.jurisdiction}, and disputes go to the courts there, unless the law where you live gives you the right to go to your local
        courts or to have your local law apply. Before going to court, contact us so we can try to solve the problem.
      </p>

      <h2>15. Contact</h2>
      <p>
        {c.entity}, {c.address}. Email: <Mail to={c.support} />.
      </p>
    </LegalDoc>
  );
}
