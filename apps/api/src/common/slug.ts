import { randomBytes } from 'node:crypto';

/** URL slug from a name. Non-Latin names (Tamil product names are common) fall back to a short random slug. */
export function slugify(input: string, fallbackPrefix = 'item'): string {
  const s = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s || `${fallbackPrefix}-${randomBytes(3).toString('hex')}`;
}

/** First free slug among base, base-2, base-3 … given a uniqueness probe. */
export async function uniqueSlug(base: string, taken: (slug: string) => Promise<boolean>): Promise<string> {
  if (!(await taken(base))) return base;
  for (let i = 2; i < 1000; i++) {
    const s = `${base}-${i}`;
    if (!(await taken(s))) return s;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}
