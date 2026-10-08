import { ASK_TOPIC_KEYS, askAreaLabel, clockTime, pluralCategory, pluralFormKey, t, type AskCityInfo } from '@yapilapi/shared';
import { Icon } from './icons.tsx';

/**
 * Ask the city (docs/product/ask-the-city.md): what a question post shows above its words. Its
 * topic and area ("Question · Food · Yaba, Lagos"), whether it still needs an answer, how many it
 * has or that it's closed, and, for safety questions, a gentle note about emergency numbers.
 */
export function AskCityTag({ ask, locale = 'en' }: { ask: AskCityInfo; locale?: string }) {
  const answers = t(pluralFormKey('askCity.answers', pluralCategory(locale, ask.answers), locale, ask.answers), locale, {
    count: new Intl.NumberFormat(locale).format(ask.answers),
  });
  const status = !ask.open
    ? t('askCity.closed', locale)
    : ask.answers === 0
      ? t('askCity.needsAnswer', locale)
      : ask.expiresAt
        ? t('askCity.openUntil', locale, { time: untilText(ask.expiresAt, locale) })
        : null;
  return (
    <div className="yp-askcity">
      <p className="yp-askcity__line">
        <Icon name="help" size={16} />
        <span className="yp-askcity__kind">{t('askCity.badge', locale)}</span>
        <span aria-hidden="true">·</span>
        <span>{t(ASK_TOPIC_KEYS[ask.topic], locale)}</span>
        <span aria-hidden="true">·</span>
        <span className="yp-askcity__area">
          <Icon name="map-pin" size={14} />
          <bdi>{askAreaLabel(ask)}</bdi>
        </span>
      </p>
      <p className="yp-askcity__meta">
        {status ? <span className={ask.open && ask.answers === 0 ? 'yp-askcity__needs' : undefined}>{status}</span> : null}
        {ask.answers > 0 ? <span>{answers}</span> : null}
        {ask.helpful > 0 ? (
          <span className="yp-askcity__helpful">
            <Icon name="check-circle" size={14} />
            {t('askCity.helpful', locale)}
          </span>
        ) : null}
      </p>
      {ask.topic === 'safety' ? (
        <p className="yp-askcity__safety" role="note">
          <Icon name="shield" size={14} />
          <span>{t('askCity.safetyNote', locale)}</span>
        </p>
      ) : null}
    </div>
  );
}

/** "18:30", or "Thu 18:30" when it's more than a day away. */
function untilText(iso: string, locale: string): string {
  if (Date.parse(iso) - Date.now() < 20 * 3_600_000) return clockTime(iso, locale);
  try {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  } catch {
    return clockTime(iso, locale);
  }
}
