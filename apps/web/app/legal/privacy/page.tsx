import Link from 'next/link';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('privacy');

/**
 * Privacy policy. Written from what the code collects today (see "Privacy inventory" in
 * docs/operations/app-store.md); when that changes, change this page. A template: a lawyer must
 * review it before launch.
 */
export default async function PrivacyPage() {
  const c = await legalContacts();
  return (
    <LegalDoc slug="privacy">
      <p>
        This policy explains what information YAPILAPI collects, why, who we share it with, how long we keep it and the choices you have. {c.entity},{' '}
        {c.address}, is responsible for your information (the “controller”). Questions or requests: <Mail to={c.privacy} />.
      </p>
      <p>We don’t sell your personal information, and we don’t use it to track you across other companies’ apps and websites.</p>

      <h2>1. What we collect</h2>
      <h3>When you create an account</h3>
      <ul>
        <li>Your email address, a password (we store only a scrambled form of it, never the password itself), your username and your name.</li>
        <li>
          Your date of birth, if you give it. We use it to protect younger people (see <Link href="/legal/safety">Safety and minors</Link>) and never show it on
          your profile.
        </li>
        <li>Your language, and the invite code you used and who invited you, if any.</li>
        <li>
          Later, if you add one, your phone number. To confirm it we send a code by text message through Twilio, and we keep a record of each code request (the
          number, time and IP address).
        </li>
      </ul>

      <h3>What you share</h3>
      <ul>
        <li>
          Your profile: photo, cover photo, bio, links, interests, the kind of profile, your “Now” status and the country you choose. Your name, username, photo
          and bio are visible to everyone who can find you; a private account shows its posts only to approved followers.
        </li>
        <li>
          What you create: posts, reels, stories, comments, reactions, polls, boards, chapters, recaps, events, communities, rooms, products, reviews and live
          videos (which are recorded, so clips can be made), with the audience you choose.
        </li>
        <li>
          Messages and calls: we store your chats, voice messages and attachments on our servers so we can deliver them. They are not end-to-end encrypted.
          Earlier versions of edited messages are kept so reports about them can be checked. View-once media is deleted once everyone has seen it, or after 14
          days; disappearing messages are deleted when they expire. Calls go directly between devices where possible (otherwise through our relay server) and
          are not recorded.
        </li>
        <li>
          Photos and videos: files can contain information added by your device, such as when and where they were taken. The sizes we show in the app are made
          without it, and photos taken with the in-app camera don’t include it. The original file you upload is kept as it was uploaded.
        </li>
        <li>Things you ask the assistant to remember (“assistant memory”). You can see and delete them in Settings.</li>
      </ul>

      <h3>How you use YAPILAPI</h3>
      <ul>
        <li>
          Sign-ins and devices: for each session, your IP address, the type of device and browser, and when it was last used. Security events (sign-ins, failed
          sign-ins including the email address typed, password changes) with the IP address and device. You can see your sessions in Settings.
        </li>
        <li>
          Activity: the posts and stories you view, reactions and saves, the feedback you give on your feed (“Show less like this”, muting), where you stopped
          in a reel, and events about actions you take (for example “created a post” or “joined a community”) with a few details about them, without your IP
          address. We use these to run your feed and to understand how YAPILAPI is used.
        </li>
        <li>Time spent: the minutes you use YAPILAPI each day, for your own reminders and, if you are a supervised teen, for your family link.</li>
        <li>Screenshots of view-once media: the phone app tells the sender, and we record that it happened.</li>
        <li>Advertising: which sponsored posts were shown to you, clicked or hidden.</li>
        <li>
          Your country, as reported by our network provider when you use YAPILAPI. We use it to apply the law in your country and, if you allow ads, to choose
          them. We don’t use your device’s location (GPS) at all.
        </li>
        <li>Notifications: a token for each browser or phone where you turn on notifications.</li>
      </ul>

      <h3>Contacts, only if you choose to find friends</h3>
      <p>
        When you look for friends from your contacts, the phone app turns each email address into a code on your phone before anything is sent, and names never
        leave your phone. On the web you can paste email addresses, which are coded in your browser. We compare the codes with those of accounts that allow it
        (adults with a confirmed email who kept “Let people who have my email find me” on), show you the matches, and don’t keep the codes; we only count how
        many were sent and matched. Phone numbers are not matched today.
      </p>

      <h3>Payments</h3>
      <p>
        When you pay, card details go straight to our payment provider: Stripe, or Paystack for some currencies in Africa. We send Paystack your email address
        with the amount. We keep your orders (what, how much, when, the provider’s reference), refunds, and the notifications the provider sends us about each
        payment, which can include your email address and the last digits and type of your card or bank. If you sell on YAPILAPI, we keep your sales and payout
        requests (amount, currency, status).
      </p>

      <h3>Safety</h3>
      <p>
        Reports you make or that are made about you, moderation decisions and appeals, and signals we use against spam and fake accounts (for example sign-ups
        from a throwaway email service or many sign-ups from the same network). Photos and videos may be checked automatically for nudity and violence (see
        section 3).
      </p>

      <h3>Family links</h3>
      <p>
        If a guardian and a teen link their accounts, we store the link, the settings the guardian chose (who can message the teen, a daily reminder, quiet
        hours) and share the teen’s daily minutes with the guardian. Guardians never see messages or activity.
      </p>

      <h2>2. How we use it</h2>
      <ul>
        <li>To provide YAPILAPI: your account, profile, feed, messages, calls, events, shops and everything else you use.</li>
        <li>
          To personalise it: your interests, who you follow and what you engage with decide what For you and Wander show. Every post can tell you why you are
          seeing it.
        </li>
        <li>To keep people safe: moderation, age protections, family links, regional rules, and preventing spam, fraud and attacks.</li>
        <li>To process payments, refunds and payouts.</li>
        <li>To contact you: notifications you turned on, and emails to confirm your address, reset your password or tell you about important changes.</li>
        <li>
          To show ads, only if you are 18 or older, turned on ads in Settings, aren’t supervised and don’t have Plus. They are chosen from your interests,
          language and country, never from your messages.
        </li>
        <li>To understand how YAPILAPI is used and improve it.</li>
        <li>To comply with the law and respond to lawful requests.</li>
      </ul>
      <p>
        Where the law requires a legal basis (for example in the European Economic Area and the United Kingdom), we rely on: our contract with you (to provide
        YAPILAPI); our legitimate interests (safety, security, preventing fraud, personalising and improving YAPILAPI), balanced against your rights; your
        consent (ads, contacts, assistant memory, notifications), which you can withdraw at any time; and legal obligations.
      </p>

      <h2>3. Who we share it with</h2>
      <ul>
        <li>
          Other people, according to the audience you choose. Public content from public accounts of people 18 and over can be seen without an account, in link
          previews and in search engines. Content from people under 18 never is.
        </li>
        <li>Apps you connect with “Sign in with YAPILAPI” and mini apps you open get only what you allowed. You can remove them in Settings.</li>
        <li>
          Companies that help us run YAPILAPI, only to do that work and under contract:
          <ul>
            <li>Hosting, database and file storage [name the providers you use, for example Render and Cloudflare R2 or Amazon S3].</li>
            <li>Stripe and Paystack, for payments.</li>
            <li>Twilio, to send phone confirmation codes.</li>
            <li>Amazon Web Services (Rekognition), to check photos and videos for nudity and violence.</li>
            <li>
              Anthropic, for AI features. What you ask for is sent: the text you want a caption or plan for, the messages of a chat you ask to summarise
              (including other people’s messages), the posts of a community or memory you ask to summarise, text you ask to translate, and for the assistants
              your interests, language and upcoming events. We keep a log of each request without its content, and keep translations so they aren’t made twice.
            </li>
            <li>If automatic captions are turned on, a speech-to-text provider [name it, for example OpenAI], which receives the sound of the video.</li>
            <li>Expo, Apple and Google, to deliver notifications to phones, and your browser’s push service on the web.</li>
            <li>
              Jamendo, when music from its catalogue plays: your device gets the song straight from Jamendo, which sees your IP address. Google’s servers help
              calls connect (STUN) and serve the website’s fonts, and also see your IP address.
            </li>
          </ul>
        </li>
        <li>
          Authorities, when the law requires it or to protect someone from serious harm, and specialised organisations when we find child sexual abuse material.
        </li>
        <li>A buyer or successor, if YAPILAPI is sold or reorganised, under this policy.</li>
      </ul>

      <h2>4. Where it is stored</h2>
      <p>
        Our servers are in [region, for example the European Union]. Some of the companies above process information in other countries, including the United
        States. Where the law requires it, we use safeguards such as the European Commission’s standard contractual clauses.
      </p>

      <h2>5. How long we keep it</h2>
      <ul>
        <li>Your account and content: until you delete them or your account.</li>
        <li>
          When you delete your account: your profile, posts, reels, stories, comments, the messages you sent, your photos and videos, connections, circles,
          interests, assistant memory and notification tokens are removed right away. Backups are replaced within 30 days.
        </li>
        <li>
          We keep, for as long as the law or people’s safety requires: records of payments, refunds and payouts; reports, moderation decisions and appeals; and
          security logs. [Set and state a period for each, for example 12 months for security logs and activity events, and the period your tax law requires for
          payment records.]
        </li>
        <li>Stories disappear from view after 24 hours (or the time you chose) and stay in your archive, visible only to you, until you delete them.</li>
      </ul>

      <h2 id="your-rights">6. Your choices and rights</h2>
      <ul>
        <li>
          <strong>See and download your data</strong>: Settings, then “Download my data”, gives you a file with your account, profile, posts, comments, messages
          you sent, connections, communities, event replies, orders, consents, assistant memory and recent security events. For anything else, write to{' '}
          <Mail to={c.privacy} />.
        </li>
        <li>
          <strong>Correct it</strong>: edit your profile and settings at any time.
        </li>
        <li>
          <strong>Delete it</strong>: delete posts and messages one by one, or your whole account in Settings (on the web: Privacy, then Delete my account; in
          the app: Your data, then Delete account).
        </li>
        <li>
          <strong>Choose</strong>: who sees each post, a private account, who can tag you, whether people with your email can find you, ads (off unless you turn
          them on), assistant memory (off unless you turn it on), notifications, and hidden words.
        </li>
        <li>
          <strong>Object, restrict, or withdraw consent</strong>, and <strong>complain</strong> to your data protection authority. Write to{' '}
          <Mail to={c.privacy} />; we answer within one month.
        </li>
      </ul>

      <h2>7. Children and teens</h2>
      <p>
        YAPILAPI is not for children under 13. If we learn that someone under 13 has an account, we delete it; if you think this has happened, write to{' '}
        <Mail to={c.safety} />. Accounts of people under 18 get extra protections, described in <Link href="/legal/safety">Safety and minors</Link>.
      </p>

      <h2>8. Security</h2>
      <p>
        We protect your information with encryption in transit (HTTPS), scrambled passwords, sessions that can be signed out from anywhere, two-step
        verification and passkeys, limits on repeated attempts, and access to personal information only for the people at YAPILAPI who need it, with a record of
        what they do. No system is perfectly secure; if a breach puts you at risk, we tell you and the authorities as the law requires.
      </p>

      <h2>9. Cookies</h2>
      <p>
        The website uses one cookie, to keep you signed in. See the <Link href="/legal/cookies">Cookie notice</Link>.
      </p>

      <h2>10. Changes</h2>
      <p>We update this policy when what we collect or how we use it changes, and tell you in the app or by email before an important change takes effect.</p>

      <h2>11. Contact</h2>
      <p>
        {c.entity}, {c.address}. Privacy questions and requests: <Mail to={c.privacy} />. [If the law requires it, add your data protection officer and your
        representative in the European Union or the United Kingdom.]
      </p>
    </LegalDoc>
  );
}
