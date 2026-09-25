/** Where a notification (or a tapped push) should take the user. Pure so it can be tested and shared. */
export interface NotificationTarget {
  kind?: string | undefined;
  targetType?: string | null | undefined;
  targetId?: string | null | undefined;
  data?: Record<string, unknown> | undefined;
  actorUsername?: string | undefined;
}

export function routeForNotification(n: NotificationTarget): string | null {
  const id = n.targetId ?? undefined;
  switch (n.targetType) {
    case 'post':
      return id ? `/post/${id}` : null;
    case 'comment': {
      const p = n.data?.['postId'];
      return typeof p === 'string' ? `/post/${p}` : null;
    }
    case 'conversation':
      return id ? `/chat/${id}` : null;
    case 'community':
      return id ? `/community/${id}` : null;
    case 'user':
      return n.actorUsername ? `/user/${n.actorUsername}` : null;
    default: {
      if (
        (n.kind === 'follow' ||
          n.kind === 'follow_request' ||
          n.kind === 'friend_request' ||
          n.kind === 'friend_accepted' ||
          n.kind === 'follow_accepted') &&
        n.actorUsername
      )
        return `/user/${n.actorUsername}`;
      return null;
    }
  }
}

/** Data payload the API attaches to pushes: strings only (see apps/api/src/lib/push-dispatch.ts). */
export function routeForPushData(data: Record<string, unknown> | undefined): string {
  if (!data) return '/notifications';
  return (
    routeForNotification({
      kind: str(data['kind']),
      targetType: str(data['targetType']),
      targetId: str(data['targetId']),
    }) ?? '/notifications'
  );
}
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
