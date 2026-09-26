import { Contact, ContactField, requestPermissionsAsync } from 'expo-contacts';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { getLocales } from 'expo-localization';
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';
import type { ContactMatch } from '../../../packages/api-client/src/index';
import { contactHashInput, normalizeEmail, type ContactKind } from '../../../packages/shared/src/contacts';
import { client } from './api';

/** A contact from the address book, with its emails and numbers normalized. Stays on the phone. */
export interface DeviceContact {
  id: string;
  name: string;
  emails: string[];
  /** E.164, read with the phone's country for numbers written without a country code. */
  phones: string[];
}

export interface ContactsResult {
  /** People on YAPILAPI, with the contact they were found from. */
  found: (ContactMatch & { contactName: string })[];
  /** Contacts with no account here, to invite. */
  others: DeviceContact[];
  checked: number;
}

/** The phone's region (for example NG or FR), used to read local phone numbers. */
function deviceCountry(): CountryCode | undefined {
  const region = getLocales().find((l) => l.regionCode)?.regionCode;
  return region ? (region.toUpperCase() as CountryCode) : undefined;
}

export function normalizePhone(raw: string, country?: CountryCode): string | null {
  try {
    const n = parsePhoneNumberFromString(raw, country);
    return n?.isValid() ? n.number : null;
  } catch {
    return null;
  }
}

/** Ask for access and read names, emails and phone numbers. Null when access is refused. */
export async function readContacts(): Promise<DeviceContact[] | null> {
  const { status } = await requestPermissionsAsync();
  if (status !== 'granted') return null;
  const rows = await Contact.getAllDetails([ContactField.FULL_NAME, ContactField.EMAILS, ContactField.PHONES] as const);
  const country = deviceCountry();
  const out: DeviceContact[] = [];
  for (const r of rows) {
    const emails = [...new Set((r.emails ?? []).map((e) => (e.address ? normalizeEmail(e.address) : null)).filter((e): e is string => !!e))];
    const phones = [...new Set((r.phones ?? []).map((p) => (p.number ? normalizePhone(p.number, country) : null)).filter((p): p is string => !!p))];
    if (!emails.length && !phones.length) continue;
    out.push({ id: r.id, name: r.fullName?.trim() || emails[0] || phones[0]!, emails, phones });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Hash every email (and phone number, once the server matches them) on the phone with the
 * server's salt and send only the hashes, in chunks. Names never leave the phone.
 */
export async function matchContacts(contacts: DeviceContact[]): Promise<ContactsResult> {
  const api = await client();
  const { salt, kinds, maxHashes } = await api.contacts.salt();
  const owner = new Map<string, DeviceContact>();
  const jobs: { kind: ContactKind; value: string; contact: DeviceContact }[] = [];
  for (const c of contacts) {
    if (kinds.includes('email')) for (const e of c.emails) jobs.push({ kind: 'email', value: e, contact: c });
    if (kinds.includes('phone')) for (const p of c.phones) jobs.push({ kind: 'phone', value: p, contact: c });
  }
  for (let i = 0; i < jobs.length; i += 200) {
    const batch = jobs.slice(i, i + 200);
    const hashes = await Promise.all(batch.map((j) => digestStringAsync(CryptoDigestAlgorithm.SHA256, contactHashInput(salt, j.kind, j.value))));
    hashes.forEach((h, k) => owner.set(h.toLowerCase(), batch[k]!.contact));
  }
  const all = [...owner.keys()];
  const found: ContactsResult['found'] = [];
  const matched = new Set<string>();
  for (let i = 0; i < all.length; i += maxHashes) {
    const { items } = await api.contacts.match(all.slice(i, i + maxHashes), 'mobile');
    for (const m of items) {
      if (found.some((f) => f.user.id === m.user.id)) continue;
      const contact = m.hashes.map((h) => owner.get(h)).find(Boolean);
      if (contact) matched.add(contact.id);
      found.push({ ...m, contactName: contact?.name ?? m.user.displayName });
    }
  }
  return { found, others: contacts.filter((c) => !matched.has(c.id)), checked: contacts.length };
}
