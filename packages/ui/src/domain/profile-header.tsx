import type { ReactNode } from 'react';
import { Avatar } from '../components/avatar';
import { Badge } from '../components/primitives';
import { LockIcon, PinIcon, LinkIcon } from '../components/icons';
import { useLowBandwidth, useUI } from '../context';
import { formatCompact, formatDate, formatNumber } from '../format';
import type { ProfileData } from './types';

export interface ProfileHeaderLabels {
  privateAccount: string;
  joined: (date: string) => string;
  followers: (n: string) => string;
  following: (n: string) => string;
  friends: (n: string) => string;
  modes: Record<string, string>;
  stats: string;
  links: string;
  privateNotice: string;
  coverAlt: string;
}

export interface ProfileHeaderProps {
  profile: ProfileData;
  labels: ProfileHeaderLabels;
  /** Follow / message / edit buttons etc. */
  actions?: ReactNode;
  onShowFollowers?: () => void;
  onShowFollowing?: () => void;
  headingLevel?: 1 | 2;
}

export function ProfileHeader({
  profile,
  labels,
  actions,
  onShowFollowers,
  onShowFollowing,
  headingLevel = 1,
}: ProfileHeaderProps) {
  const { locale } = useUI();
  const lowBw = useLowBandwidth();
  const H = `h${headingLevel}` as 'h1';
  const count = (n: number) => formatCompact(n, locale);
  const stat = (text: string, onClick?: () => void) =>
    onClick ? (
      <button type="button" className="yl-profile__stat yl-profile__stat--btn" onClick={onClick}>
        {text}
      </button>
    ) : (
      <span className="yl-profile__stat">{text}</span>
    );
  return (
    <header className="yl-profile">
      <div className="yl-profile__cover" data-lowbw={profile.coverUrl ? 'hide' : undefined}>
        {profile.coverUrl && !lowBw ? (
          <img src={profile.coverUrl} alt="" className="yl-profile__cover-img" loading="lazy" />
        ) : null}
      </div>
      <div className="yl-profile__row">
        <Avatar
          name={profile.displayName}
          src={profile.avatarUrl}
          size="xl"
          className="yl-profile__avatar"
        />
        <div className="yl-profile__actions">{actions}</div>
      </div>
      <div className="yl-profile__id">
        <H className="yl-profile__name">{profile.displayName}</H>
        <p className="yl-profile__handle" dir="ltr">
          @{profile.username}
        </p>
        <p className="yl-profile__badges">
          {profile.mode !== 'personal' ? (
            <Badge tone="secondary">{labels.modes[profile.mode] ?? profile.mode}</Badge>
          ) : null}
          {profile.isPrivate ? (
            <Badge tone="neutral" icon={<LockIcon size={12} />}>
              {labels.privateAccount}
            </Badge>
          ) : null}
        </p>
      </div>
      {profile.bio ? <p className="yl-profile__bio">{profile.bio}</p> : null}
      <ul className="yl-profile__facts">
        {profile.locationText ? (
          <li>
            <PinIcon size={16} />
            <span>{profile.locationText}</span>
          </li>
        ) : null}
        <li>
          {labels.joined(formatDate(profile.joinedAt, locale, { month: 'long', year: 'numeric' }))}
        </li>
        {profile.links.map((l) => (
          <li key={l.url}>
            <LinkIcon size={16} />
            <a href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc" dir="ltr">
              {l.label}
            </a>
          </li>
        ))}
      </ul>
      <p className="yl-profile__stats" role="group" aria-label={labels.stats}>
        {stat(labels.followers(count(profile.counts.followers)), onShowFollowers)}
        {stat(labels.following(count(profile.counts.following)), onShowFollowing)}
        {stat(labels.friends(formatNumber(profile.counts.friends, locale)))}
      </p>
      {profile.contentHidden ? <p className="yl-profile__notice">{labels.privateNotice}</p> : null}
    </header>
  );
}
