import type { RawArticle } from '../normalize';

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeUrl(href: string, baseUrl: string): string {
  try {
    return new URL(decodeHtml(href), baseUrl).toString();
  } catch {
    return '';
  }
}

function isNatureArticle(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (hostname === 'nature.com' || hostname.endsWith('.nature.com')) &&
      /\/articles\//.test(parsed.pathname);
  } catch {
    return false;
  }
}

function inferTitle(anchorHtml: string): string {
  // Some Nature links wrap the entire card, including standfirst and date.
  const heading = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/i.exec(anchorHtml);
  const title = stripHtml(heading ? heading[2] : anchorHtml);
  return title.replace(/^Nature\s+/, '').trim();
}

function getHtmlAttribute(tag: string, name: string): string {
  const regex = new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)["']`, 'i');
  const match = tag.match(regex);
  return match ? decodeHtml(match[1]).trim() : '';
}

function normalizePublishedAt(value: string): string | undefined {
  const cleaned = decodeHtml(value).trim();
  const parsed = new Date(cleaned);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();

  const dateOnly = cleaned.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/);
  if (!dateOnly) return undefined;

  const year = Number(dateOnly[1]);
  const month = Number(dateOnly[2]) - 1;
  const day = Number(dateOnly[3]);
  return new Date(Date.UTC(year, month, day)).toISOString();
}

function extractPublishedAtFromHtml(html: string): string | undefined {
  const publishedMetaNames = new Set([
    'article:published_time',
    'og:published_time',
    'pubdate',
    'date',
    'datepublished',
    'dc.date',
    'dc:date',
  ]);

  const metaRegex = /<meta\b[^>]*>/gi;
  let metaMatch: RegExpExecArray | null;
  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const tag = metaMatch[0];
    const name = (
      getHtmlAttribute(tag, 'property') ||
      getHtmlAttribute(tag, 'name') ||
      getHtmlAttribute(tag, 'itemprop')
    ).toLowerCase();

    if (!publishedMetaNames.has(name)) continue;

    const content = getHtmlAttribute(tag, 'content');
    if (!content) continue;

    const publishedAt = normalizePublishedAt(content);
    if (publishedAt) return publishedAt;
  }

  const timeRegex = /<time\b[^>]*>/gi;
  let timeMatch: RegExpExecArray | null;
  while ((timeMatch = timeRegex.exec(html)) !== null) {
    const datetime = getHtmlAttribute(timeMatch[0], 'datetime');
    if (!datetime) continue;

    const publishedAt = normalizePublishedAt(datetime);
    if (publishedAt) return publishedAt;
  }

  return undefined;
}

function isArticleCardTag(tag: string, attributes: string): boolean {
  if (tag === 'article' || tag === 'li') return true;
  if (tag !== 'div' && tag !== 'section') return false;
  const className = getHtmlAttribute(attributes, 'class');
  return /(?:^|[-_\s])(?:article|card|story|result)(?:$|[-_\s])/i.test(className);
}

/** Return the nearest recognizable card containing this link, including metadata
 * that appears before or after the link. If markup provides no card boundary,
 * return only the link so metadata from neighboring entries cannot leak in. */
function getArticleCardHtml(html: string, anchorStart: number, anchorEnd: number): string {
  const tagRegex = /<\/?([a-z][\w:-]*)\b[^>]*>/gi;
  const stack: Array<{ tag: string; start: number; card: boolean }> = [];
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null && match.index < anchorStart) {
    const rawTag = match[0];
    const tag = match[1].toLowerCase();
    if (rawTag.startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag !== tag) continue;
        stack.splice(i);
        break;
      }
    } else if (!/\/\s*>$/.test(rawTag) && !['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'].includes(tag)) {
      stack.push({ tag, start: match.index, card: isArticleCardTag(tag, rawTag) });
    }
  }

  const nearestCard = [...stack].reverse().find((element) => element.card);
  if (!nearestCard) return html.slice(anchorStart, anchorEnd);

  const sameTagRegex = new RegExp(`<\\/?${nearestCard.tag}\\b[^>]*>`, 'ig');
  sameTagRegex.lastIndex = nearestCard.start;
  let depth = 0;
  let end = anchorEnd;
  while ((match = sameTagRegex.exec(html)) !== null) {
    if (match[0].startsWith('</')) depth -= 1;
    else if (!/\/\s*>$/.test(match[0])) depth += 1;
    if (depth === 0) {
      end = sameTagRegex.lastIndex;
      break;
    }
  }
  return html.slice(nearestCard.start, end);
}

export async function fetchHtml(url: string, timeoutMs: number = 10000): Promise<RawArticle[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NatureDaily/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!res.ok) return [];

    const text = await res.text();
    const items: RawArticle[] = [];
    const seen = new Set<string>();
    const anchorRegex = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let match: RegExpExecArray | null;

    while ((match = anchorRegex.exec(text)) !== null) {
      const link = normalizeUrl(match[1], url);
      if (!link || seen.has(link) || !isNatureArticle(link)) continue;

      const title = inferTitle(match[2]);
      if (title.length < 12) continue;

      const card = getArticleCardHtml(text, match.index, anchorRegex.lastIndex);

      seen.add(link);
      items.push({
        title,
        link,
        pubDate: extractPublishedAtFromHtml(card),
      });
    }

    return items;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}
