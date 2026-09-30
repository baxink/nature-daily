export interface RawArticle {
  title: string;
  link: string;
  description?: string;
  pubDate?: string;
  imageUrl?: string;
}

export interface NormalizedArticle {
  id: string;
  sourceId: string;
  country: string;
  mediaName: string;
  title: string;
  summary: string;
  url: string;
  imageUrl: string;
  publishedAt: string | null;
  fetchedAt: string;
  lang: string;
}

function generateId(sourceId: string, url: string): string {
  const str = `${sourceId}:${url}`;
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return `art_${Math.abs(hash).toString(36)}`;
}

function parseDate(dateStr?: string): string | null {
  if (!dateStr) return null;
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeArticles(
  raw: RawArticle[],
  sourceId: string,
  country: string,
  mediaName: string,
  lang: string,
  limit: number
): NormalizedArticle[] {
  const now = new Date().toISOString();
  return raw.slice(0, limit).map(item => ({
    id: generateId(sourceId, item.link),
    sourceId,
    country,
    mediaName,
    title: stripHtml(item.title),
    summary: stripHtml(item.description || ''),
    url: item.link,
    imageUrl: item.imageUrl || '',
    publishedAt: parseDate(item.pubDate),
    fetchedAt: now,
    lang,
  }));
}
