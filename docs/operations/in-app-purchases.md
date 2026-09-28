# Paying in the phone apps: a decision memo

Written 2026-09-28 for the owner. This memo is not legal advice. The rules below are changing quickly, especially in the United States, so check them again before each app submission.

## The decision

Apple and Google take a cut when people buy **digital goods** inside their apps. They also limit how an app can send people to a website to pay. For physical goods and real-world services, you can use any checkout.

YAPILAPI sells both kinds of thing. You need to decide how the iPhone and Android apps handle the digital ones.

Nothing is blocked while you decide. The apps ship with the safest setting, and you can change it later on the server, with no new app release.

## What YAPILAPI sells, and how the stores see it

| What people pay for | Digital or not | What the apps do by default |
| --- | --- | --- |
| Plus (monthly add-on) | Digital | No price or button. Plain line: "You can manage Plus on the web." |
| Subscriptions to creators | Digital | Plans and perks shown without prices. No button. |
| Tips and live gifts | Digital. Apple only exempts gifts where 100% goes to the person, and YAPILAPI takes 5%. | No tip or gift button. |
| Boosts and ad budget | Digital. Apple names "boosts" for posts explicitly. | Results shown. No boost form. |
| Digital downloads | Digital | No price or button, unless the person already owns the download. Owned downloads still open. |
| Tickets to a live stream | Digital. Apple treats one-to-many streams as needing In-App Purchase. | "This live needs a ticket", with no price or button. |
| Shop products and drops of physical products | Physical | Unchanged: checkout opens on the web. |
| Booked services, such as a portrait session | Real-world service | Unchanged |
| Tickets to events in a real place | Real-world service | Unchanged |
| Place bookings | Free | Unchanged |

In every case, the web app keeps selling everything. The API also refuses to start a digital checkout that a phone asks for when the setting doesn't allow it. That means a modified app can't get around the setting.

## The options

| | A. Hide (the default) | B. Link to the web | C. Store payments |
| --- | --- | --- | --- |
| **What people see** | No price or buy button for digital goods, only a line that they're managed on the web. This is the "reader app" pattern that Netflix and Kindle use. | A button that opens the web checkout in the browser. Only offered in the countries you list. Elsewhere it behaves like A. | Apple's or Google's own purchase sheet |
| **Fees on digital sales** | None to Apple or Google. You pay only the card fee on the web, typically around 3%. | See [Fees](#fees). In the US today Apple takes 0%, but that may change. Google charges a fee on link-outs. | Apple 30%, or 15% under the Small Business Program. Google 10–15% on your first $1M, depending on the country. |
| **Work left** | None. This is built and on. | None for the app. Before switching Android, enrol in Google's external offers or alternative billing programme in Play Console. | Weeks, for each store. See [If you choose store payments](#if-you-choose-store-payments). |
| **Risk of rejection** | Lowest | Low in the US. Anywhere else it needs Apple's link entitlement, which isn't built, so keep the list to US for iPhone. | Low once it's built, but review of the purchases themselves takes time |
| **Downside** | Some phone users won't buy, because they have to think of the website themselves | US rules may change (see below). The fees can take much of the saving. | Large cut. Prices set by creators (plans, tips, downloads) don't fit the stores' fixed price lists. |

## Fees

These are the figures as reported in September 2026. Check them before relying on them.

### Apple

- **Standard:** 30%.
- **Subscriptions after their first year:** 15%.
- **Small Business Program:** 15% if you earned under $1M the year before. You must apply.
- **US link-outs:** since the court order of 30 April 2025, Apple may not charge anything on them, so today the rate is 0%.
  - On 13 August 2026 Apple proposed 15% (standard), 10% and 5% (small business). No fee had been approved in the reports we found.
- **EU, from 1 October 2026:**

  | How people pay | Standard | Reduced (small business and later subscription years) |
  | --- | --- | --- |
  | In-App Purchase | 26% | 15% |
  | Your own payment inside the app | 20% | 10% |
  | Link-outs | 15% | 10% |

- **Japan:**
  - In-App Purchase: 21% plus a 5% processing fee, or 10% plus 5% at the reduced rate.
  - Link-outs: 15%, or 10% at the reduced rate.

### Google

- **EEA, UK and US, since 30 June 2026:**
  - 10% on your first $1M a year.
  - 10% on subscriptions that renew automatically.
  - Above $1M: 20% for new installs and 25% for existing installs, or 20% on external web links.
  - Using Google Play Billing adds a further 5%.
- **Other countries, until Google's new model reaches them:** 15% on the first $1M, 30% above that, and 15% on subscriptions.
  - Australia switches on 30 September 2026.
  - Japan and Korea switch on 31 December 2026.
  - The rest of the world switches by 30 September 2027.
- **User choice billing:** where it still exists (for example Korea and India), it takes 4 points off the fee.

## The US situation

The following is certain as of September 2026:

- In *Epic v. Apple*, a court ordered on 30 April 2025 that US apps may link and point to web purchases freely, with no Apple commission.
- The appeal court upheld that order on 11 December 2025. It also said Apple may eventually charge a reasonable fee, and the district court is now working out that fee.
- The Supreme Court agreed on 30 June 2026 to hear one narrow question in the case. Argument is expected in 2027.
- Apple's own guidelines, last updated 8 June 2026, say US storefront apps may use buttons and links to outside purchases.

What is uncertain is how long the 0% lasts. A fee could be set in the coming months, and a Supreme Court decision in 2027 could change the rules again. That is why option B is a setting you can turn off in a minute.

## Our recommendation

1. **Submit the first versions with option A (hide) on both stores.** This is the current setting.
   - It is the least likely to be rejected, costs nothing, and needs no more work.
   - People can still buy everything on the website, and physical products, services and event tickets keep working in the app.
   - Say so in the App Review notes. The suggested wording is in [app-store.md](app-store.md), section 6.
2. **After the app is approved, consider turning on option B for the US only.**
   - Do this if Plus or creator sales from phones turn out to matter.
   - It is a setting change, and it can be undone the same way.
   - Watch the US fee news, because a fee may follow.
   - On Android, enrol in Google's programme in Play Console first.
3. **Only build option C (store payments) if phone sales of digital goods become a real share of revenue.**
   - Plus would be the first and simplest product to move.
   - Creator-priced goods (plans, tips, downloads) are much harder to move.
   - Another choice here is to take no fee on tips, and never tie tips to content. Apple's rule 3.2.1(vii) then allows them without In-App Purchase. That is a product and pricing decision.

## Which setting to change

The settings are environment variables on the API service, **yapilapi-api** in the Render dashboard, under Environment.

- Changing one restarts the API.
- Phones pick up the change the next time they load the app. Answers are kept for at most a minute.
- The current values show in the web admin console under **Feature flags**, in the card "Phone app purchases".

| Your choice | iPhone | Android |
| --- | --- | --- |
| A. Hide (default) | `IOS_DIGITAL_PURCHASES=hidden` | `ANDROID_DIGITAL_PURCHASES=play_billing_required` |
| B. Link to the web, US only | `IOS_DIGITAL_PURCHASES=external_link` and `IOS_EXTERNAL_LINK_COUNTRIES=US` | `ANDROID_DIGITAL_PURCHASES=user_choice` and `ANDROID_USER_CHOICE_COUNTRIES=US`, after enrolling in Play Console |
| B, with more countries | Only once Apple's link entitlement for those countries is added to the app. Until then keep `US`. | Add two-letter country codes separated by commas, for example `US,GB`, for countries you enrolled in Google's programme |
| C. Store payments | `IOS_DIGITAL_PURCHASES=iap`, once the StoreKit work below is done. Until then it behaves like hidden. | Not available yet. It needs Google Play Billing, built the same way. |

To decide which country applies, the app compares:

- the phone's region;
- the country on the person's account;
- once StoreKit is added, the App Store country.

All of them must be in the list, or the app hides the button. When in doubt, it hides.

## If you choose store payments

These are the steps for an engineer. Nothing here is installed yet.

1. **Add a native StoreKit 2 module to the iPhone build.**
   - Use an Expo config plugin or a small local module.
   - The typed seam it must fill is `StoreBilling` in `apps/mobile/lib/store.tsx`. It covers the storefront country, products, purchase and restore. It is marked `TODO(iap)`.
2. **Create the products in App Store Connect**, for example a one-month Plus non-renewing subscription.
3. **Add an API route that checks each signed transaction** with Apple's App Store Server API before granting anything. Also handle App Store Server Notifications for refunds.
4. **Show a "Restore purchases" action.**
5. **Do the same for Android** with Google Play Billing, and add a Play mode to `ANDROID_DIGITAL_PURCHASES`.
6. **Set `IOS_DIGITAL_PURCHASES=iap`.** The API keeps refusing card checkouts from the iPhone in this mode.

## Sources

Checked 27–28 September 2026.

- Apple App Review Guidelines, sections 3.1.1, 3.1.1(a), 3.1.3(d), 3.1.3(e), 3.1.3(g) and 3.2.1(vii) (last updated 8 June 2026): https://developer.apple.com/app-store/review/guidelines/
- Apple, alternative terms in the EU (announced 18 August 2026, effective 1 October 2026): https://developer.apple.com/support/dma-and-apps-in-the-eu/
- Apple, app distribution in Japan (iOS 26.2): https://developer.apple.com/support/app-distribution-in-japan/
- Ninth Circuit, *Epic Games v. Apple*, No. 25-2935 (11 December 2025): https://law.justia.com/cases/federal/appellate-courts/ca9/25-2935/25-2935-2025-12-11.html
- Supreme Court docket 25-1311 (certiorari granted 30 June 2026; docket read through 21 September 2026): https://www.supremecourt.gov/docket/docketfiles/html/public/25-1311.html
- MacRumors on Apple's proposed US link-out fees (13 August 2026): https://www.macrumors.com/2026/08/13/app-store-fees-apple-link-outs/
- MacRumors on Apple's Supreme Court brief (14 September 2026): https://www.macrumors.com/2026/09/14/apple-supreme-court-contempt-ruling/
- Google Play Payments policy (no date shown): https://support.google.com/googleplay/android-developer/answer/9858738
- Google Play service fees (no date shown; new fees from 30 June 2026): https://support.google.com/googleplay/android-developer/answer/112622
- Android Developers Blog on expanded billing choices (24 June 2026): https://android-developers.googleblog.com/2026/06/play-expanded-billing.html
- Ars Technica on the withdrawn Epic–Google settlement changes and third-party stores in Play (15 July 2026): https://arstechnica.com/gadgets/2026/07/third-party-app-stores-coming-to-google-play-next-week-as-epic-settlement-withdrawn/

### What we could not confirm

- The exact details of the November 2025 Epic–Google settlement.
- Whether Google's new fee applies to US link-outs, given what the court order allows.
- The details of Apple's June 2025 EU terms, which the October 2026 terms replace.
- How strictly App Review applies the tip and gift rules to creator tips. That is our reading of the guidelines.
