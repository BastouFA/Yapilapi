import { containsSecret } from './safety/screen.js';

/**
 * Memory candidates come ONLY from what the user says in their own message (never from retrieved posts, DMs, tool output or
 * model text: that would let a poisoned source write to memory). They are SUGGESTIONS: nothing is stored until the user approves.
 */
const PATTERNS: RegExp[] = [
  /\bremember (?:that )?(.{3,240}?)(?:[.!]|$)/i,
  /\b(my name is [\p{L}'’ -]{2,40})/iu,
  /\b(i(?:'m| am) (?:allergic to|vegetarian|vegan|lactose intolerant|gluten[- ]free|based in|from|learning|training for|a (?:student|teacher|nurse|developer|designer|chef|photographer|musician|writer|founder)) ?[^.!?\n]{0,120})/i,
  /\b(i (?:prefer|really like|love|hate|usually|always|never|live in|work (?:as|at|in|for)|study|speak) [^.!?\n]{2,140})/i,
];

const CONTACT = /\b[\w.+-]+@[\w-]+\.[\w.]+\b|(?:\+\d[\d ()-]{7,})/;

export function extractMemoryCandidates(message: string, max = 3): string[] {
  const text = message.trim();
  if (!text || text.endsWith('?') || text.length > 600) return [];
  // Check the WHOLE message: a sentence split must never cut a contact detail or secret in half and let a fragment through.
  if (CONTACT.test(text) || containsSecret(text)) return [];
  const out: string[] = [];
  for (const re of PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const c = (m[1] ?? m[0]).trim().replace(/\s+/g, ' ');
    if (c.length < 4 || c.length > 300 || containsSecret(c) || CONTACT.test(c)) continue;
    const sentence = c.charAt(0).toUpperCase() + c.slice(1);
    if (!out.some((o) => o.toLowerCase() === sentence.toLowerCase())) out.push(sentence);
    if (out.length >= max) break;
  }
  return out;
}
