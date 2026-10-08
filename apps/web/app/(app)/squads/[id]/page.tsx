'use client';

import { useParams } from 'next/navigation';
import { SquadPage } from '@/components/Squads';
import { FeatureOff } from '@/components/FeatureOff';
import { useSession } from '@/app/providers';

/** One squad, for the people in it (and those invited to it). Anyone else gets "not found". */
export default function SquadRoute() {
  const { id } = useParams<{ id: string }>();
  const { t, flags } = useSession();
  if (flags.SQUADS === false) return <FeatureOff name={t('squads.title')} />;
  return (
    <div className="yp-shell__inner">
      <SquadPage id={id} />
    </div>
  );
}
