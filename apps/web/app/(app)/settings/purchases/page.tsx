'use client';

import { PurchasesCard } from '@/components/Shop';
import { SettingsPage } from '@/components/settings/Shell';

/** Purchases: what you bought, with downloads for digital items. */
export default function PurchasesSettings() {
  return (
    <SettingsPage section="purchases">
      <PurchasesCard />
    </SettingsPage>
  );
}
