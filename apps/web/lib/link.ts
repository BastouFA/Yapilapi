import Link from 'next/link';
import type { LinkLike } from '@yapilapi/design-system';

/** next/link typed for design-system components that accept `linkAs`. */
export const NextLink = Link as unknown as LinkLike;
