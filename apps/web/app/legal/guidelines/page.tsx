import Link from 'next/link';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('guidelines');

/** Community guidelines. A template: a lawyer and a trust and safety lead must review it before launch. */
export default async function GuidelinesPage() {
  const c = await legalContacts();
  return (
    <LegalDoc slug="guidelines">
      <p>
        YAPILAPI is for sharing your life with the people and communities you care about. These guidelines apply to everything on YAPILAPI: posts, reels,
        stories, comments, messages, profiles, communities, events, rooms, live videos, shops and ads. They are part of the{' '}
        <Link href="/legal/terms">Terms of service</Link>.
      </p>

      <h2>Be respectful</h2>
      <ul>
        <li>No harassment or bullying: repeated unwanted contact, insults, pile-ons, or sharing someone’s content to mock them.</li>
        <li>
          No hate: attacking people for their race, ethnicity, national origin, caste, religion, disability, disease, sex, gender identity, sexual orientation
          or age.
        </li>
        <li>No threats of violence, and no praise or support for violent or hateful organisations and their attacks.</li>
      </ul>

      <h2>Keep people safe</h2>
      <ul>
        <li>
          Nothing that sexualises anyone under 18, ever. We remove it, end the account and report it to the authorities and to organisations that fight child
          sexual abuse.
        </li>
        <li>No grooming, and no asking people under 18 for sexual content, private meetings or personal details.</li>
        <li>
          No content that encourages suicide, self-harm or eating disorders. Talking about your own experience to find support is allowed. If someone is in
          danger, contact local emergency services.
        </li>
        <li>No dangerous challenges, and no instructions for making weapons or explosives.</li>
      </ul>

      <h2>Nudity and sexual content</h2>
      <p>
        No sexual activity, pornography or sexual services. Nudity is not allowed except in clearly non-sexual contexts such as breastfeeding, health, art and
        protest, and then only in content people choose to see. Photos and videos may be checked automatically; content marked sensitive is covered until you
        choose to see it, and is never shown to people under 18 or whose age we don’t know. Never share intimate images of someone without their consent.
      </p>

      <h2>Graphic content</h2>
      <p>No gore or extreme violence shared to shock or celebrate. Newsworthy content can stay if it is marked sensitive and doesn’t glorify suffering.</p>

      <h2>Be real</h2>
      <ul>
        <li>No impersonation. Parody and fan accounts must say so in their name or bio.</li>
        <li>No spam: repetitive posts, mass messages or invites, misleading links, or buying and selling followers, likes or views.</li>
        <li>No scams or fraud: fake giveaways, phishing, pyramid schemes, or asking for money under false pretences.</li>
        <li>No false information that can cause real harm, such as dangerous health claims or lies about how, when or where to vote.</li>
        <li>Label content made or heavily changed with AI when it could mislead people about something real.</li>
      </ul>

      <h2>Respect privacy</h2>
      <p>
        Don’t share other people’s private information (home address, phone number, documents, private messages) without their permission, and don’t film or
        photograph people in private places without their consent.
      </p>

      <h2>Respect creators</h2>
      <p>
        Only share what you made or have the right to share. Credit others, use the music picker for songs (it only offers music with a licence for use on
        YAPILAPI), and see <Link href="/legal/copyright">Copyright and takedowns</Link>.
      </p>

      <h2>Selling and advertising</h2>
      <p>
        Don’t sell or advertise weapons, drugs, tobacco and vaping products, alcohol to people under the legal age, counterfeit goods, stolen goods, animals
        protected by law, human remains, or anything illegal where you or the buyer are. Sponsored posts are reviewed before they run. The{' '}
        <Link href="/legal/creators">Creator and seller terms</Link> have the details.
      </p>

      <h2>What we do when rules are broken</h2>
      <p>
        Depending on how serious it is and whether it has happened before, we may: remove the content, limit who sees it or blur it, hold it for review,
        withhold it in a country where it is illegal, remove features such as live video or messaging, limit your account for a while, or end it. Serious harm,
        like child sexual abuse or credible threats, ends the account on the first time. We tell you what we did and why, and you can appeal in Settings; a
        person reviews every appeal.
      </p>

      <h2>How to report</h2>
      <p>
        Use Report in the menu of a post, reel, profile or message. Reports are confidential: the person is not told who reported them. You can also block
        someone, mute people and topics, and hide comments with words you choose. Reports about the safety of someone under 18 hide the content while we look at
        it. For anything else, write to <Mail to={c.safety} />.
      </p>
    </LegalDoc>
  );
}
