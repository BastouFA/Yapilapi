import type { TOOL_SPECS } from '@yapilapi/ai';
import type { z } from 'zod';
import { answerGrounded } from '../grounded.js';
import { translate } from '../translation.js';
import type { ToolContext, ToolResult } from '../types.js';

type In<K extends keyof typeof TOOL_SPECS> = z.infer<(typeof TOOL_SPECS)[K]['input']>;

export async function communityFaqAnswer(
  tc: ToolContext,
  input: In<'community_faq_answer'>,
): Promise<ToolResult> {
  const a = await answerGrounded(tc, 'community', input.communityId, input.question);
  return {
    result: { display: a.answer, answer: a.answer, documented: a.documented },
    sources: a.sources,
  };
}

export async function businessAssistantAnswer(
  tc: ToolContext,
  input: In<'business_assistant_answer'>,
): Promise<ToolResult> {
  const a = await answerGrounded(tc, 'business', input.businessId, input.question);
  return {
    result: { display: a.answer, answer: a.answer, documented: a.documented },
    sources: a.sources,
  };
}

export async function translateTool(tc: ToolContext, input: In<'translate'>): Promise<ToolResult> {
  await tc.ctx.flags.require('AI_TRANSLATION', tc.principal.userId);
  const t = await translate(tc.ctx, tc.runtime, tc.permissions, tc.principal, {
    targetType: 'caption',
    text: input.text,
    targetLanguage: input.targetLanguage,
    ...(input.sourceLanguage ? { sourceLanguage: input.sourceLanguage } : {}),
  });
  tc.turn.providers.add(t.translation.provider);
  return {
    result: {
      display: `${t.translation.text}\n(Machine translation to ${t.translation.languageName}; your original text is unchanged.)`,
      translation: t.translation.text,
      original: t.original.text,
      language: t.translation.language,
      provider: t.translation.provider,
    },
    sources: [],
  };
}
