import Link from 'next/link';
import { PLATFORM_FEE_PERCENT } from '@yapilapi/shared';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('creators');

/**
 * Creator and seller terms: selling, drops, subscriptions, tips and gifts, lives, boosts, payouts and
 * the platform fee and payment processing (PLATFORM_FEE_BPS and PROCESSING_FEES in
 * packages/shared/src/constants.ts). Not legal advice: see docs/legal/review-pack.md and docs/legal/placeholders.md.
 */
export default async function CreatorsPage() {
  const c = await legalContacts();
  const fee = `${PLATFORM_FEE_PERCENT}%`;
  return (
    <LegalDoc slug="creators">
      <p>
        These terms apply when you earn money on YAPILAPI: selling products, tickets, services and bookings, digital downloads, drops, subscriber-only posts and
        reels, tips and live gifts, ticketed lives and live shopping, and when you pay to boost a post. They add to the{' '}
        <Link href="/legal/terms">Terms of service</Link> and the <Link href="/legal/guidelines">Community guidelines</Link>.
      </p>

      <h2>1. Who can earn</h2>
      <ul>
        <li>
          You must be 18 or older, or the age of adulthood where you live if that is higher, and able to enter into contracts. We check your date of birth
          before you can list something for sale, start a paid plan, receive tips or ask for a payout.
        </li>
        <li>You need a confirmed email address to ask for a payout. We may ask you to confirm your identity, your business details or tax information.</li>
        <li>A business account can only use music cleared for commercial use.</li>
      </ul>

      <h2>2. What you can sell</h2>
      <p>
        Only things you have the right to sell and that are legal where you and your buyers are. The things listed under “Selling and advertising” in the
        Community guidelines are not allowed. Describe what you sell accurately, including the price, what is included, delivery or booking times, and your
        refund conditions. You are the seller: you are responsible for what you sell, for delivering it and for your customers.
      </p>

      <h2>3. Prices, payment and the platform fee</h2>
      <ul>
        <li>You set your prices. Buyers pay through YAPILAPI’s checkout, processed by Stripe or, for some currencies in Africa, Paystack.</li>
        <li>
          YAPILAPI keeps a platform fee of <strong>{fee}</strong> of each sale, booking, subscription payment, tip and gift. The cost of processing the payment
          is taken off as well: what the payment provider charges for it, such as a share of the amount plus a small fixed amount for cards. Both are shown in
          Studio with each sale, and a payment can&apos;t cost you more than it brought in.
        </li>
        <li>You are responsible for the taxes on what you earn, unless the law makes us collect them, in which case we show them at checkout.</li>
      </ul>

      <h2>4. Drops</h2>
      <p>
        A drop announces a launch of some of your own products (up to 12) ahead of time: when it opens, optionally when it closes, how many of each product and
        a limit per person. People can ask to be reminded, which costs them nothing; you see how many are waiting, never who. Until it opens, the products in a
        published drop can’t be bought anywhere, and after it ends they stay off sale until you put them in another drop.
      </p>
      <ul>
        <li>Describe the drop accurately, and only announce what you can deliver. You can edit it until it opens, and cancel it at any time.</li>
        <li>
          When it opens, everyone waiting is told. Each order holds its units for 15 minutes while the buyer pays; unpaid units go back on sale. We never sell
          more than the number you set. A payment that arrives after the units have gone is refunded to the buyer.
        </li>
        <li>
          If you cancel a drop, everyone waiting is told, unpaid orders are cancelled, and paid orders follow the usual refund rules in section 8. You are
          responsible for delivering, or refunding, every paid order.
        </li>
      </ul>

      <h2>5. Subscriptions</h2>
      <p>
        Subscribers pay the price you set for 30 days of your subscriber-only posts and reels. If a subscriber cancels, they keep access until the end of the
        period they paid for. Each period is paid separately; we will tell subscribers before any automatic renewal is introduced.
      </p>

      <h2>6. Tips, gifts and lives</h2>
      <p>
        Tips and live gifts are voluntary and don’t buy anything in return. They are not refunded, except where the law requires it or in cases of fraud. A gift
        appears in the live’s chat for everyone once the payment is confirmed. A ticketed live can only be watched by people who bought a ticket. Lives are
        recorded: you get the recording and up to three highlight clips, which you can keep or delete.
      </p>

      <h2>7. Digital downloads and services</h2>
      <p>
        Files you sell are stored privately and buyers get a download link that works for 10 minutes each time. If you delete your account, these files are kept
        so buyers can still download what they paid for. [How long buyers keep access after a seller leaves.] Bookable services are confirmed or declined by
        you, and a booking that is cancelled before payment is not charged.
      </p>

      <h2>8. Refunds and disputes</h2>
      <p>
        You can refund a paid order from Studio. Buyers ask you for refunds; there is no automatic refund window in YAPILAPI, so your refund conditions, and the
        consumer law where your buyers live, apply. [Minimum refund rules sellers must offer.] We may refund a buyer ourselves, and take the amount back from
        your earnings, when you don’t deliver, when the item isn’t as described, in cases of fraud, or when the law requires it. If a buyer disputes a payment
        with their bank, the amount and any dispute fee can be taken back from your earnings until it is resolved.
      </p>

      <h2>9. Payouts</h2>
      <p>
        Ask for a payout of your available earnings in Studio. Earnings become available 7 days after each sale. Payouts are paid in the currency you earned: US
        dollars, euros and pounds to a Stripe account you set up on Stripe&apos;s own pages, and naira, cedis, shillings and rand to a bank or mobile money
        account you give us, through Paystack. The smallest payout is about US$10 in any currency. Each request is checked by our team; once approved it is sent
        the same day, and banks usually show it within a few working days. A payout that your bank refuses or reverses goes back to your available earnings. We
        may hold payouts while we look into fraud, disputes or a breach of these terms, and we tell you why.
      </p>

      <h2>10. Boosting posts</h2>
      <p>
        When you pay to boost one of your own public posts, it is reviewed before it runs and must follow the advertising rules. It is labelled as sponsored and
        shown only to adults who turned on ads, aren’t supervised and don’t have Plus, in the countries, languages and interests you choose, a limited number of
        times a day per person. You pay per thousand times it is shown. Results (times shown, clicks, people reached) are shown on the post and in Studio, never
        who saw it. Budget that isn’t spent, including when a boost is refused, is refunded automatically.
      </p>

      <h2>11. Business insights</h2>
      <p>
        Business accounts see totals for their pages and places: visitors per day, bookings, ratings, sales and ads. They never see who visited. Use them only
        to run your business.
      </p>

      <h2>12. Ending</h2>
      <p>
        We may stop your ability to earn if you break these terms. Earnings you made legitimately before that remain yours, minus refunds, disputes and fees.
        Questions: <Mail to={c.support} />.
      </p>
    </LegalDoc>
  );
}
