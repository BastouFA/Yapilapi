import { describe, expect, it } from 'vitest';
import {
  approximatePoint,
  bearingDegrees,
  compassPoint,
  distanceMetres,
  isLive,
  locationAlt,
  locationFromYou,
  locationStatus,
  mapPattern,
  mapsUrl,
  pointFor,
  precisePoint,
  relativePosition,
  roundedDistance,
  type LocationShare,
  type LocationWords,
} from './location.ts';
import { t, tp } from './i18n.ts';

const lagos = { lat: 6.52437, lng: 3.37921 };

describe('location helpers', () => {
  it('keeps precise points to about a metre', () => {
    expect(precisePoint({ lat: 6.524371234, lng: 3.379219876 })).toEqual({ lat: 6.52437, lng: 3.37922 });
    expect(precisePoint({ lat: 95, lng: 190 })).toEqual({ lat: 90, lng: -170 });
  });

  it('snaps approximate points to a grid about a kilometre across, the same way twice', () => {
    const a = approximatePoint(lagos);
    expect(distanceMetres(a, lagos)).toBeLessThan(800);
    expect(approximatePoint(a)).toEqual(a);
    // Two places a few hundred metres apart in the same square get the same corner.
    expect(approximatePoint({ lat: lagos.lat + 0.001, lng: lagos.lng + 0.001 })).toEqual(approximatePoint({ lat: lagos.lat - 0.0005, lng: lagos.lng }));
    // Far north the grid is still about a kilometre wide.
    const oslo = { lat: 59.9139, lng: 10.7522 };
    expect(distanceMetres(approximatePoint(oslo), oslo)).toBeLessThan(800);
    expect(pointFor(lagos, 'approximate')).toEqual(a);
    expect(pointFor(lagos, 'precise')).toEqual(precisePoint(lagos));
  });

  it('works out distance and direction', () => {
    const north = { lat: lagos.lat + 0.02, lng: lagos.lng };
    expect(distanceMetres(lagos, north)).toBeGreaterThan(2_200);
    expect(distanceMetres(lagos, north)).toBeLessThan(2_250);
    expect(compassPoint(bearingDegrees(lagos, north))).toBe('n');
    expect(relativePosition(lagos, { lat: lagos.lat + 0.015, lng: lagos.lng + 0.015 }).direction).toBe('ne');
    expect(relativePosition(lagos, { lat: lagos.lat - 0.015, lng: lagos.lng - 0.015 }).direction).toBe('sw');
    expect(compassPoint(359)).toBe('n');
    expect(compassPoint(-90)).toBe('w');
  });

  it('rounds distances the way people say them', () => {
    expect(roundedDistance(40)).toEqual({ unit: 'near', value: 100 });
    expect(roundedDistance(430)).toEqual({ unit: 'm', value: 450 });
    expect(roundedDistance(2_340)).toEqual({ unit: 'km', value: 2.3 });
    expect(roundedDistance(12_600)).toEqual({ unit: 'km', value: 13 });
  });

  it('opens each platform’s maps with only the coordinates', () => {
    expect(mapsUrl(lagos, 'web')).toBe('https://www.openstreetmap.org/?mlat=6.52437&mlon=3.37921#map=15/6.52437/3.37921');
    expect(mapsUrl(lagos, 'ios')).toBe('https://maps.apple.com/?ll=6.52437,3.37921&q=6.52437,3.37921');
    expect(mapsUrl(lagos, 'android')).toBe('geo:6.52437,3.37921?q=6.52437,3.37921');
  });

  it('knows when a share is live', () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    expect(isLive({ mode: 'live', stoppedAt: null, endsAt: soon })).toBe(true);
    expect(isLive({ mode: 'live', stoppedAt: new Date().toISOString(), endsAt: soon })).toBe(false);
    expect(isLive({ mode: 'live', stoppedAt: null, endsAt: new Date(Date.now() - 1).toISOString() })).toBe(false);
    expect(isLive({ mode: 'once', stoppedAt: null, endsAt: null })).toBe(false);
  });

  it('says where someone is in words, for people who can’t see the card', () => {
    const w: LocationWords = { t: (k, v) => t(k, 'en', v), tp: (k, c, v) => tp(k, c, 'en', v), locale: 'en' };
    const now = Date.now();
    const ada = { id: 'a', username: 'ada', displayName: 'Ada', avatarUrl: null, mode: 'personal' as const };
    const target = { lat: lagos.lat + 0.0145, lng: lagos.lng + 0.0145 };
    const share: LocationShare = {
      id: 's',
      messageId: 'm',
      conversationId: 'c',
      sharer: ada,
      mode: 'live',
      precision: 'precise',
      point: { ...target, accuracyM: 10, at: new Date(now - 20_000).toISOString() },
      startedAt: new Date(now - 60_000).toISOString(),
      endsAt: new Date(now + 3_600_000).toISOString(),
      live: true,
      stoppedAt: null,
      stopReason: null,
    };
    expect(locationAlt(w, share, 'me', lagos, now)).toBe('Ada is about 2.3 km north-east of you, updated 20 seconds ago');
    expect(locationAlt(w, share, 'me', null, now)).toBe('Where Ada is, updated 20 seconds ago. Open in maps to see the place.');
    expect(locationAlt(w, share, 'me', target, now)).toBe('Ada is less than 100 m from you, updated 20 seconds ago');
    expect(locationAlt(w, { ...share, stoppedAt: new Date(now).toISOString(), point: null }, 'me', lagos, now)).toBe('Ada stopped sharing where they are');
    expect(locationFromYou(w, lagos, target)).toBe('About 2.3 km north-east of you');
    expect(locationStatus(w, share, now)).toMatch(/^Updated 20 s ago · Until /);
    expect(locationStatus(w, { ...share, mode: 'once', endsAt: null }, now)).toBe('Sent once');
  });

  it('draws the same pattern for the same place', () => {
    expect(mapPattern(lagos)).toEqual(mapPattern(lagos));
    expect(mapPattern(lagos)).toHaveLength(7);
    expect(mapPattern(lagos)).not.toEqual(mapPattern({ lat: 51.5, lng: -0.12 }));
  });
});
