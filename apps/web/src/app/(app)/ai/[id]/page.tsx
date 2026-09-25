import { ChatView } from '@/components/ai/ChatView';

export default async function AiConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ChatView conversationId={decodeURIComponent(id)} />;
}
