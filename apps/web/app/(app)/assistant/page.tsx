'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Segments } from '@yapilapi/design-system';
import type { AgentKind } from '@yapilapi/api-client';
import { AGENTS, AgentPanel } from '@/components/AgentPanel';
import { useSession } from '@/app/providers';

const KINDS = Object.keys(AGENTS) as AgentKind[];

/** Assistants for finding things, planning trips, shopping and running a business. */
export default function AssistantPage() {
  const params = useSearchParams();
  const router = useRouter();
  const { t } = useSession();
  const kind = (KINDS.includes(params.get('kind') as AgentKind) ? params.get('kind') : 'discover') as AgentKind;
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>{t('m.title.assistant')}</h1>
      </div>
      <Segments
        label={t('m.title.assistant')}
        value={kind}
        onChange={(k) => router.replace(`/assistant?kind=${k}`)}
        options={KINDS.map((k) => ({ id: k, label: t(AGENTS[k].title) }))}
      />
      <AgentPanel key={kind} kind={kind} />
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {t('agent.privacy')}
      </p>
    </div>
  );
}
