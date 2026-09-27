import Link from 'next/link';
import { PLATFORM_FEE_PERCENT } from '@yapilapi/shared';
import { LegalDoc } from '@/components/Legal';
import { legalContacts, legalMetadata, Mail } from '@/lib/legal';

export const generateMetadata = () => legalMetadata('creators');

/** Creator and seller terms: selling, subscriptions, tips, boosts, payouts and the platform fee. A template. */
export default async function CreatorsPage() {
  const c = await legalContacts();
  const fee = `${PLATFORM_FEE_PERCENT}%`;
  return (
    <LegalDoc slug="creators">
      <p>
        These terms apply when you earn money on YAPILAPI: selling products, tickets, services and bookings, digital downloads, subscriber-only posts and reels,
        tips and gifts, and live shopping. They add to the <Link href="/legal/terms">Terms of service</Link> and the{' '}
        <Link href="/legal/guidelines">Community guidelines</Link>.
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
          YAPILAPI keeps a platform fee of <strong>{fee}</strong> of each sale, booking, subscription payment and tip. The fee is shown in Studio with each
          sale. [Say whether payment processing costs are included in the fee or deducted as well.]
        </li>
        <li>You are responsible for the taxes on what you earn, unless the law makes us collect them, in which case we show them at checkout.</li>
      </ul>

      <h2>4. Subscriptions</h2>
      <p>
        Subscribers pay the price you set for 30 days of your subscriber-only posts and reels. If a subscriber cancels, they keep access until the end of the
        period they paid for. Each period is paid separately; we will tell subscribers before any automatic renewal is introduced.
      </p>

      <h2>5. Tips and gifts</h2>
      <p>Tips and live gifts are voluntary and don’t buy anything in return. They are not refunded, except where the law requires it or in cases of fraud.</p>

      <h2>6. Digital downloads and services</h2>
      <p>
        Files you sell are stored privately and buyers get a download link that works for 10 minutes each time. Bookable services are confirmed or declined by
        you, and a booking that is cancelled before payment is not charged.
      </p>

      <h2>7. Refunds and disputes</h2>
      <p>
        You can refund an order from Studio. We may refund a buyer ourselves, and take the amount back from your earnings, when you don’t deliver, when the item
        isn’t as described, in cases of fraud, or when the law requires it. If a buyer disputes a payment with their bank, the amount and any dispute fee can be
        taken back from your earnings until it is resolved.
      </p>

      <h2>8. Payouts</h2>
      <p>
        Ask for a payout of your available earnings in Studio. Each request is checked by our team before it is paid [say how, in which currencies, the minimum
        amount and how long it takes]. We may hold payouts while we look into fraud, disputes or a breach of these terms, and we tell you why.
      </p>

      <h2>9. Boosting posts</h2>
      <p>
        When you pay to boost a post, it is reviewed before it runs and must follow the advertising rules. It is shown to adults who allowed ads, in the
        countries and interests you choose. Results are shown on the post and in Studio. Budget that isn’t spent, including when a boost is refused, is refunded
        automatically.
      </p>

      <h2>10. Ending</h2>
      <p>
        We may stop your ability to earn if you break these terms. Earnings you made legitimately before that remain yours, minus refunds, disputes and fees.
        Questions: <Mail to={c.support} />.
      </p>
    </LegalDoc>
  );
}
