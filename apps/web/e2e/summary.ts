/**
 * Summarise the last axe run (e2e/.results/<project>/<page>.json):
 * `node e2e/summary.ts` after `pnpm test:a11y` (`--details` lists every element).
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

interface Violation {
  id: string;
  impact: string;
  nodes: { target: string; summary?: string }[];
}

const details = process.argv.includes('--details');

const root = path.join(import.meta.dirname, '.results');
const byRule = new Map<string, { impact: string; nodes: number; pages: Set<string> }>();
const byProject: Record<string, { violations: number; nodes: number }> = {};

for (const project of readdirSync(root).sort()) {
  byProject[project] = { violations: 0, nodes: 0 };
  for (const file of readdirSync(path.join(root, project))) {
    const page = file.replace(/\.json$/, '');
    const list = JSON.parse(readFileSync(path.join(root, project, file), 'utf8')) as Violation[];
    for (const v of list) {
      if (details) for (const n of v.nodes) console.log(`${project} ${page} ${v.id}: ${n.target}\n    ${n.summary ?? ''}`);
      byProject[project].violations++;
      byProject[project].nodes += v.nodes.length;
      const r = byRule.get(v.id) ?? { impact: v.impact, nodes: 0, pages: new Set<string>() };
      r.nodes += v.nodes.length;
      r.pages.add(page);
      byRule.set(v.id, r);
    }
  }
}

console.log('| Project | Violations (rule × page) | Elements |\n| --- | ---: | ---: |');
for (const [p, c] of Object.entries(byProject)) console.log(`| ${p} | ${c.violations} | ${c.nodes} |`);
console.log('\n| Rule | Impact | Elements (all projects) | Pages |\n| --- | --- | ---: | --- |');
for (const [id, r] of [...byRule].sort((a, b) => b[1].nodes - a[1].nodes))
  console.log(`| ${id} | ${r.impact} | ${r.nodes} | ${[...r.pages].sort().join(', ')} |`);
