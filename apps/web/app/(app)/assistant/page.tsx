'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Segments } from '@yapilapi/design-system';
import type { AgentKind } from '@yapilapi/api-client';
import { AGENTS, AgentPanel } from '@/components/AgentPanel';

const KINDS = Object.keys(AGENTS) as AgentKind[];

/** Assistants for finding things, planning trips, shopping and running a business. */
export default function AssistantPage() {
  const params = useSearchParams();
  const router = useRouter();
  const kind = (KINDS.includes(params.get('kind') as AgentKind) ? params.get('kind') : 'discover') as AgentKind;
  return (
    <div className="yp-shell__inner">
      <div className="yp-topbar">
        <h1>Assistant</h1>
      </div>
      <Segments
        label="Assistant"
        value={kind}
        onChange={(k) => router.replace(`/assistant?kind=${k}`)}
        options={KINDS.map((k) => ({ id: k, label: AGENTS[k].title }))}
      />
      <AgentPanel key={kind} kind={kind} />
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        The assistant searches YAPILAPI as you, so it only finds what you could find yourself. It never books, buys or joins anything without your tap. Your
        question is sent to the AI provider to answer it; YAPILAPI keeps a record that you asked, not what you asked.
      </p>
    </div>
  );
}
