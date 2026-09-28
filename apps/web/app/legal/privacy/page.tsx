import Link from 'next/link';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('privacy');

/**
 * Privacy policy. Written from what the code collects today (packages/database/migrations,
 * apps/api/src/modules/privacy.ts, apps/api/src/lib/retention.ts and "Privacy inventory" in
 * docs/operations/app-store.md); when that changes, change this page. Not legal advice: the full
 * inventory and the questions for the lawyer are in docs/legal/review-pack.md, and every
 * [bracketed placeholder] is listed in docs/legal/placeholders.md.
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
          Your date of birth. Everyone gives it when they sign up (accounts made before we asked give it once, the next time they sign in). We use it to refuse
          people under 13, to protect people under 18 (see <Link href="/legal/safety">Safety and minors</Link>), and to check that people who sell, get paid or
          receive tips are 18 or older. We never show it on your profile.
        </li>
        <li>Your language, and the invite code you used and who invited you, if any.</li>
        <li>
          Later, if you add one, your phone number. To confirm it we send a code by text message through Twilio, and we keep a record of each code request (the
          number, time and IP address).
        </li>
        <li>
          If you change your username: the old and new names and when you changed them. Your old name is held for you for 14 days, during which links and
          @mentions using it still lead to your profile and nobody else can take it.
        </li>
      </ul>

      <h3>What you share</h3>
      <ul>
        <li>
          Your profile: photo, cover photo, bio, name, pronouns, links (up to 5), interests, the kind of profile, the colours and layout you choose, the posts
          you feature, a profile song, your “Now” status, a city if you add one, and a country if you choose one. Your name, username, photo and bio are visible
          to everyone who can find you; a private account shows its posts only to approved followers. The city on the profile of someone under 18 is never shown
          to others.
        </li>
        <li>
          To show the icon of the websites you link to, our server fetches each site’s small icon itself and keeps it for about a week. The linked site sees our
          server, not you or your visitors.
        </li>
        <li>
          What you create: posts, reels, stories, comments, reactions, polls, boards, chapters, recaps, memories, events, communities, rooms, products, reviews,
          drops and live videos (which are recorded, so you get the recording and clips can be made), with the audience you choose. Drafts and scheduled posts
          are seen only by you until they are published. Earlier versions of edited posts and comments are kept, and people who can see the post can open them.
        </li>
        <li>
          Messages and calls: we store your chats, voice messages, attachments, polls, shared lists, reminders and games in chats on our servers so we can
          deliver them. They are not end-to-end encrypted. Earlier versions of edited messages are kept so reports about them can be checked. View-once media is
          deleted once everyone has seen it, or after 14 days; disappearing messages are deleted when they expire (24 hours, 7 days or 90 days, as the chat
          chose). Calls go directly between devices where possible (otherwise through our relay server) and are not recorded; we keep a history of who called
          whom, when and for how long. Audio rooms are not recorded.
        </li>
        <li>
          Messages you schedule with “Send later” are stored until their time, seen only by you, and then sent like any other message. Chat wallpapers and
          bubble colours are stored with the chat and seen by everyone in it.
        </li>
        <li>
          Games in chats (Four up, Noughts, Word ladder and Chess): the board, each move (and chess draw offers), who played and who won. Only the people in the
          chat see them.
        </li>
        <li>
          Watch together: while people in a chat watch videos together, we keep the session, who joined and left, the queue of videos and where playback is.
        </li>
        <li>
          Questions (“Ask me”): if you turn on a question box, we keep its settings, the questions you receive and your answers. When you ask a question, we
          always store that it was you. If you ask “without your name shown”, the person you asked and everyone else can’t see who asked, and neither can their
          data download, but our moderators can see it when they review the question, and we can disclose it when the law requires it.
        </li>
        <li>
          Photos, videos and voice notes: files can contain information added by your device, such as where and when they were taken and the camera used. We
          remove it before we store anything: the file we keep, and every size and copy made from it, has no location or device information.
        </li>
        <li>Things you ask the assistant to remember (“assistant memory”), only if you turn it on. You can see and delete them in Settings.</li>
      </ul>

      <h3>What we make for you</h3>
      <ul>
        <li>
          Weekly wrap: unless you turn it off in Settings, on Sunday evening in your time zone we put together a private look back at your week (what you
          shared, new friends, communities you joined, events and places, songs you used and a moment from your own posts). For this we keep the time zone your
          device reports. Nothing is made for a week without activity. Only you see it, and you can delete it.
        </li>
        <li>
          On this day: a card showing your own posts from this date in earlier years. It is worked out when you open the app and is not stored separately.
        </li>
        <li>
          Catch me up: if the switch is on in Settings, we note when you open Pulse, so that after 12 hours or more away we can offer a summary of what your
          friends and the people you follow shared. Summaries and suggested chat replies are kept for 7 days so they can be shown again.
        </li>
      </ul>

      <h3>How you use YAPILAPI</h3>
      <ul>
        <li>
          Sign-ins and devices: for each session, your IP address, the type of device and browser, and when it was last used. Security events (sign-ins, failed
          sign-ins including the email address typed, password changes, username changes) with the IP address and device. You can see your sessions in Settings.
        </li>
        <li>
          Sign-in alerts: for each account, a list of the devices it has signed in from, described as the browser or app and system (for example “Chrome on
          macOS”) and, when our network provider reports it, the country. When a sign-in comes from a device not on the list, we tell you in the app and, unless
          you turn it off in Settings, by email.
        </li>
        <li>
          Activity: the posts and stories you view, reactions and saves, the feedback you give on your feed (“Show less like this”, muting), where you stopped
          in a reel, and events about actions you take (for example “created a post” or “joined a community”) with a few details about them, without your IP
          address. We use these to run your feed and to understand how YAPILAPI is used. If you turn off “Analytics” in Settings (Privacy), we stop recording
          these events for you and unlink the ones already recorded from your account.
        </li>
        <li>Story views: the person who posted a story can see who viewed it.</li>
        <li>
          Visits to business and place pages: which signed-in accounts visited on which day. Business owners see only totals (visitors per day), never who
          visited.
        </li>
        <li>Time spent: the minutes you use YAPILAPI each day, for your own reminders and, if you are a supervised teen, for your family link.</li>
        <li>Screenshots of view-once media: the phone app tells the sender, and we record that it happened.</li>
        <li>Advertising: which sponsored posts were shown to you, clicked or hidden.</li>
        <li>
          Your country, as reported by our network provider when you use YAPILAPI, or as you choose it in Settings. We use it to apply the law in your country,
          to check where music may be played, for sign-in alerts and, if you allow ads, to choose them. We don’t use your device’s location (GPS) at all.
        </li>
        <li>Your settings: for example who can message, comment on or mention you, quiet hours and their time zone, and notification choices.</li>
        <li>Notifications: a token for each browser or phone where you turn on notifications.</li>
        <li>Problems you report from Settings (Help): what you wrote, the page and the app version.</li>
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
        When you pay, card details go straight to our payment provider: Stripe, or Paystack for payments in Nigerian naira, Ghanaian cedi, Kenyan shillings and
        South African rand. We send Paystack your email address with the amount. We keep your orders (what, how much, when, the provider’s reference), refunds,
        and the notifications the provider sends us about each payment, which can include your email address and the last digits and type of your card or bank.
        If you sell on YAPILAPI, we keep your products, drops, sales and payout requests (amount, currency, status). If you ask to be reminded about a drop, we
        keep that you asked; the seller sees only how many people are waiting, never who. Units of a drop in an unpaid order are held for you for 15 minutes.
      </p>

      <h3>Safety</h3>
      <p>
        Reports you make or that are made about you, moderation decisions and appeals, and signals we use against spam and fake accounts (for example sign-ups
        from a throwaway email service or many sign-ups from the same network). Photos and videos may be checked automatically for nudity and violence (see
        section 3). Text in posts, comments, messages and questions is checked automatically by our own software for harmful content and spam.
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
          To personalise it: your interests, who you follow and what you engage with decide what For you, Reels and Wander show and who we suggest you follow.
          Every post can tell you why you are seeing it. If you turn off “Personalization” in Settings (Privacy), these use nothing about you: they are ranked
          the same way for everyone, by how recent posts are and how many people engage with them. Your own filters (muted people and topics, “Not interested”)
          still apply.
        </li>
        <li>To keep people safe: moderation, age protections, family links, regional rules, sign-in alerts, and preventing spam, fraud and attacks.</li>
        <li>To process payments, refunds, drops and payouts.</li>
        <li>
          To contact you: notifications you turned on, and emails to confirm your address, reset your password, alert you to a new sign-in or a change to your
          account’s security, and tell you about important changes. We don’t send marketing emails.
        </li>
        <li>
          To show ads, only if you are 18 or older, turned on ads in Settings, aren’t supervised and don’t have Plus. They are chosen from your interests,
          language and country, never from your messages.
        </li>
        <li>To make the optional AI features work when you use them (see “AI features” below).</li>
        <li>To understand how YAPILAPI is used and improve it.</li>
        <li>To comply with the law and respond to lawful requests.</li>
      </ul>
      <p>
        Where the law requires a legal basis (for example in the European Economic Area and the United Kingdom), we rely on: our contract with you (to provide
        YAPILAPI); our legitimate interests (safety, security, preventing fraud, personalising and improving YAPILAPI), balanced against your rights; your
        consent (ads, contacts, assistant memory, notifications), which you can withdraw at any time; and legal obligations. [Legal bases to be confirmed by
        counsel for each country.]
      </p>

      <h3 id="ai">AI features</h3>
      <p>
        These features are optional and only run when you use them (Catch me up runs when you open its card). What they produce is labelled as made with AI.
        What is sent to Anthropic, the company whose model answers:
      </p>
      <ul>
        <li>Catch me up on Pulse and in communities: the text of recent posts you can see from the people and communities involved.</li>
        <li>
          Suggested replies in chats: the last messages of the chat (up to 12) that you can see, including other people’s. None for view-once, voice, polls,
          lists or sensitive messages. On by default in one-to-one chats, off in groups and for people under 18; you can turn it off per chat or in Settings.
        </li>
        <li>Suggest a description: the photo you want described, made smaller.</li>
        <li>
          Suggest a caption: your draft text, your photos (made smaller) and, if Personalization is on, the text of a few of your recent posts. Using an idea
          marks the post as made with AI assistance.
        </li>
        <li>
          See translation: the text you ask to translate. Summaries of a chat or a memory: the messages or posts in it that you can see. Captions and plans: the
          text you give. The assistants: your request, your interests, language and upcoming events, and what their tools find for you.
        </li>
      </ul>
      <p>
        We keep a log of each request (the feature, when, whether it worked) without its content for 90 days, and keep translations so they aren’t made twice.
        [Confirm Anthropic’s retention and model-training terms for your account.] If automatic captions are turned on, the sound of the video goes to a
        speech-to-text provider ([Speech-to-text provider]).
      </p>

      <h2>3. Who we share it with</h2>
      <ul>
        <li>
          Other people, according to the audience you choose. Public content from public accounts of people 18 and over can be seen without an account, in link
          previews and in search engines. Content from people under 18 never is.
        </li>
        <li>
          Apps you connect with “Sign in with YAPILAPI” can act for you within what you allowed (read, or read and write), but never reach your security
          settings, data download, payouts, privacy choices or assistant memory. Mini apps you open in a chat, community or event get a code that identifies you
          only to that app and, if they asked for it, your username, name and photo, and the names of the people in the chat. You can remove connected apps in
          Settings.
        </li>
        <li>
          If you have a developer app, notifications about your own account (new followers, replies to your events, paid orders, your new posts) can be sent to
          the web address you set.
        </li>
        <li>
          Companies that help us run YAPILAPI, only to do that work and under contract:
          <ul>
            <li>Hosting, database, cache and file storage: [Hosting providers].</li>
            <li>An email delivery service, to send our emails: [Email provider].</li>
            <li>Stripe and Paystack, for payments.</li>
            <li>Twilio, to send phone confirmation codes.</li>
            <li>Amazon Web Services (Rekognition), to check photos and frames of videos for nudity and violence, when turned on.</li>
            <li>Anthropic, for the AI features described above.</li>
            <li>A speech-to-text provider for automatic captions, when turned on: [Speech-to-text provider].</li>
            <li>
              Expo, Apple and Google, to deliver notifications to phones, and your browser’s push service on the web. A notification carries a short line, such
              as a person’s name and what happened, not the content of your messages.
            </li>
            <li>
              Our network provider, which handles traffic to YAPILAPI and tells us the country each request comes from: [CDN provider]. If we turn on
              performance tracing, technical records of requests (which can include IP addresses) go to [Tracing provider].
            </li>
          </ul>
        </li>
        <li>
          Some companies are contacted by your device directly and see your IP address: Jamendo or a music licensing partner, when you play a song from their
          catalogue (nothing loads before you press play); Google’s servers, which help calls connect (STUN); Stripe, whose payment form loads at checkout; and
          the developer of a mini app you open. The website’s fonts are served by YAPILAPI itself, not by Google.
        </li>
        <li>
          Authorities, when the law requires it or to protect someone from serious harm, and specialised organisations when we find child sexual abuse material.
        </li>
        <li>A buyer or successor, if YAPILAPI is sold or reorganised, under this policy.</li>
      </ul>

      <h2>4. Where it is stored</h2>
      <p>
        Our servers are in [Server region]. Some of the companies above process information in other countries, including the United States. Where the law
        requires it, we use safeguards such as the European Commission’s standard contractual clauses. [Transfer safeguards to be confirmed by counsel.]
      </p>

      <h2>5. How long we keep it</h2>
      <ul>
        <li>Your account and content: until you delete them or your account.</li>
        <li>
          When you delete a post, story, comment, question, message or recap, it disappears right away and is erased for good, with its photos and videos, 30
          days later. Content removed by our moderators is kept for 180 days first, for appeals and legal requests.
        </li>
        <li>
          When you delete your account: your profile (name, photo, cover, bio, links, pronouns, city, country, colours and layout, featured and pinned posts,
          profile song and “Now” status), posts, reels, stories, comments, the messages you sent and the ones scheduled to send, questions you asked and
          received, weekly wraps, your photos, videos and voice notes (with every size and streaming copy made of them), live recordings, recap videos,
          connections, circles, interests, assistant memory, username history, the devices remembered for sign-in alerts, notification tokens and passkeys are
          removed right away, and you are signed out everywhere. Backups are replaced within 30 days. Files of digital products you sold are kept so buyers can
          still download what they paid for. [Owner to confirm how long.]
        </li>
        <li>
          A daily clean-up deletes, after these periods:
          <ul>
            <li>Sessions that expired or were signed out: 30 days.</li>
            <li>Security events (sign-ins, failed sign-ins, password and two-step changes) with their IP address and device: 12 months.</li>
            <li>Activity events (see “How you use YAPILAPI”): 13 months. The minutes you use YAPILAPI each day: 13 months.</li>
            <li>Notifications: 12 months. Phone number checks: 90 days. The log of AI requests: 90 days.</li>
            <li>AI summaries and suggested replies: 7 days.</li>
            <li>Email and password reset links, sign-in challenges, download links and unfinished uploads: 7 days after they are used or expire.</li>
            <li>View-once photos and videos that were never sent: 24 hours. The raw recording of a live on our video server: 2 days after it ends.</li>
            <li>Our record of actions taken on accounts, money and moderation (the audit log): 2 years.</li>
          </ul>
        </li>
        <li>
          We keep, for as long as the law or people’s safety requires: records of payments, refunds and payouts ([Payment records retention period]); and
          reports, moderation decisions and appeals ([Moderation records retention period]).
        </li>
        <li>
          Some records have no fixed period yet and are kept while your account exists: the devices remembered for sign-in alerts, your username history, call
          history, watch together sessions, games in chats, visits to business pages and the times you opened Pulse. [Owner to set periods for these.]
        </li>
        <li>Stories disappear from view after 24 hours (or the time you chose) and stay in your archive, visible only to you, until you delete them.</li>
      </ul>

      <h2 id="your-rights">6. Your choices and rights</h2>
      <ul>
        <li>
          <strong>See and download your data</strong>: Settings, then “Download my data”, gives you a file with the information linked to your account: your
          account and profile, what you created and the messages you sent, your connections, purchases and sales, settings, and security records. Who asked you
          a question without their name shown stays out of it. If you need something that isn’t in it, write to <Mail to={c.privacy} />.
        </li>
        <li>
          <strong>Correct it</strong>: edit your profile and settings at any time.
        </li>
        <li>
          <strong>Delete it</strong>: delete posts, questions and messages one by one, or your whole account in Settings (on the web: Privacy, then Delete my
          account; in the app: Your data, then Delete account).
        </li>
        <li>
          <strong>Choose</strong>: who sees each post, a private account, who can message, comment on, mention or tag you, whether people with your email can
          find you, ads (off unless you turn them on), assistant memory (off unless you turn it on), personalization and analytics (on unless you turn them off,
          in Settings, Privacy), the AI helpers, the weekly wrap, sign-in alert emails, notifications and quiet hours, and hidden words.
        </li>
        <li>
          <strong>Object, restrict, or withdraw consent</strong>, and <strong>complain</strong> to your data protection authority. Write to{' '}
          <Mail to={c.privacy} />; we answer within one month.
        </li>
      </ul>

      <h2>7. Children and teens</h2>
      <p>
        YAPILAPI is not for children under 13. We ask everyone’s date of birth when they sign up and don’t create an account for anyone under 13. If an existing
        account gives a date of birth under 13, it is closed straight away. If we learn in another way that someone under 13 has an account, we delete it; if
        you think this has happened, write to <Mail to={c.safety} />. Accounts of people under 18 get extra protections, described in{' '}
        <Link href="/legal/safety">Safety and minors</Link>, and people under 18 can’t sell, get paid or receive tips.
      </p>

      <h2>8. Security</h2>
      <p>
        We protect your information with encryption in transit (HTTPS), scrambled passwords, sessions that can be signed out from anywhere, two-step
        verification and passkeys, alerts when your account is signed in from a new device, limits on repeated attempts, and access to personal information only
        for the people at YAPILAPI who need it, with a record of what they do. No system is perfectly secure; if a breach puts you at risk, we tell you and the
        authorities as the law requires.
      </p>

      <h2>9. Cookies</h2>
      <p>
        The website uses one cookie, to keep you signed in. See the <Link href="/legal/cookies">Cookie notice</Link>.
      </p>

      <h2>10. Changes</h2>
      <p>We update this policy when what we collect or how we use it changes, and tell you in the app or by email before an important change takes effect.</p>

      <h2>11. Contact</h2>
      <p>
        {c.entity}, {c.address}. Privacy questions and requests: <Mail to={c.privacy} />. [Data protection officer and EU or UK representative, if required.]
      </p>
    </LegalDoc>
  );
}
