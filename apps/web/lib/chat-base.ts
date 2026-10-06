'use client';

import { usePathname } from 'next/navigation';

/**
 * Where chats live: under /yap in Yap mode (chats on their own, installable as their own app),
 * else under /inbox in the full app. Links between chats stay in whichever one you're in.
 */
export function useChatBase(): '/yap' | '/inbox' {
  return usePathname()?.startsWith('/yap') ? '/yap' : '/inbox';
}
