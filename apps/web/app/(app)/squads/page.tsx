'use client';

import { SquadsHome } from '@/components/Squads';
import { FeatureOff } from '@/components/FeatureOff';
import { useSession } from '@/app/providers';

/** Your squads: small private groups of friends, and the invites waiting for you. */
export default function SquadsPage() {
  const { t, flags } = useSession();
  if (flags.SQUADS === false) return <FeatureOff name={t('squads.title')} />;
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('squads.title')}</h1>
      </div>
      <SquadsHome />
    </div>
  );
}
