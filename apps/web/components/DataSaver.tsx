'use client';

import { useEffect, useState } from 'react';
import { Card, Segments, Select } from '@yapilapi/design-system';
import { formatBytes, type DataSaverMode } from '@yapilapi/shared';
import { api, errorMessage } from '@/lib/api';
import { onSessionBytes, type DeviceDataSaver } from '@/lib/data-saver';
import { useSession } from '@/app/providers';

/**
 * Settings: Data saver (Off / On / Automatic) on the account, this browser's own
 * choice, whether it is on right now, and an estimate of the data used this session.
 */
export function DataSaverCard() {
  const { me, setMe, toast, t, dataSaver } = useSession();
  const [bytes, setBytes] = useState(0);
  useEffect(() => onSessionBytes(setBytes), []);
  if (!me) return null;
  const modes: { id: DataSaverMode; label: string }[] = [
    { id: 'off', label: t('dataSaver.off') },
    { id: 'on', label: t('dataSaver.on') },
    { id: 'auto', label: t('dataSaver.auto') },
  ];
  const setAccount = async (mode: DataSaverMode) => {
    const before = me;
    setMe({ ...me, dataSaver: mode });
    try {
      await api.me.setDataSaver(mode);
    } catch (e) {
      setMe(before);
      toast(errorMessage(e));
    }
  };
  return (
    <Card title={t('dataSaver.title')} subtitle={t('dataSaver.hint')}>
      <div className="stack">
        <div className="stack-sm">
          <Segments options={modes} value={dataSaver.account} onChange={(m) => void setAccount(m)} label={t('dataSaver.title')} />
          <p className="muted setting-hint">{t('dataSaver.account')}</p>
          <p className="muted setting-hint">{t('dataSaver.autoWeb')}</p>
        </div>
        <Select label={t('dataSaver.device')} value={dataSaver.device} onChange={(e) => dataSaver.setDevice(e.currentTarget.value as DeviceDataSaver)}>
          <option value="account">{t('dataSaver.deviceAccount')}</option>
          {modes.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </Select>
        <p role="status">{dataSaver.active ? t('dataSaver.nowOn') : t('dataSaver.nowOff')}</p>
        <div className="stack-sm">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>{t('dataSaver.used')}</span>
            <strong>{formatBytes(bytes)}</strong>
          </div>
          <p className="muted setting-hint">{t('dataSaver.usedHint')}</p>
        </div>
      </div>
    </Card>
  );
}
