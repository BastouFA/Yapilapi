import type { PoolClient } from 'pg';
import type { Queryable } from '@yapilapi/database';
import type { AppContext } from '../../lib/context.js';

/**
 * Data-export sections. Every module that owns personal data registers a section so the export stays complete as
 * modules are added (mirror image of `registerDeletionHook` in lib/hooks.ts). A section returns plain JSON: only data
 * the USER owns or authored; never other people's private data and never secrets (tokens, password hashes, keys).
 */
export interface ExportSection {
  key: string;
  description: string;
  collect(ctx: AppContext, db: Queryable, userId: string): Promise<unknown>;
}

const sections: ExportSection[] = [];

export function registerExportSection(section: ExportSection): void {
  if (sections.some((s) => s.key === section.key)) return;
  sections.push(section);
}
export const getExportSections = (): readonly ExportSection[] => sections;

export type Tx = PoolClient;
