const MAX_SUMMARY_LENGTH = 2000;

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return decodeHtml(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getAttribute(tag: string, name: string): string {
  const match = tag.match(new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  if (!match) return '';
  return decodeHtml((match[2] ?? match[3] ?? '').trim());
}

function truncate(value: string): string {
  if (value.length <= MAX_SUMMARY_LENGTH) return value;
  return `${value.slice(0, MAX_SUMMARY_LENGTH).trimEnd()}…`;
}

/** Meta tags that carry the article standfirst or abstract, in priority order. */
const META_SUMMARY_KEYS = [
  'description',
  'dc.description',
  'og:description',
  'dcterms.description',
  'twitter:description',
];

function metaValues(html: string): Map<string, string> {
  const values = new Map<string, string>();
  const metaRegex = /<meta\b[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = metaRegex.exec(html)) !== null) {
    const tag = match[0];
    const key = (
      getAttribute(tag, 'name') ||
      getAttribute(tag, 'property') ||
      getAttribute(tag, 'itemprop')
    ).toLowerCase();
    if (!key || values.has(key)) continue;

    const content = stripHtml(getAttribute(tag, 'content'));
    if (content) values.set(key, content);
  }

  return values;
}

function extractMetaSummary(html: string): string {
  const values = metaValues(html);

  for (const key of META_SUMMARY_KEYS) {
    const content = values.get(key);
    if (!content) continue;
    // Twitter cards repeat "Nature - <title>" as a placeholder teaser; it is not
    // a real abstract, so skip it and let the article body provide the summary.
    if (key === 'twitter:description' && /^nature\s*[–-]\s*/i.test(content)) continue;
    return content;
  }

  return '';
}

/** Return the index just after the </div> that closes the <div> starting at openIndex. */
function findClosingDiv(html: string, openIndex: number): number {
  const tagRegex = /<div\b[^>]*>|<\/div>/gi;
  tagRegex.lastIndex = openIndex;
  let depth = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    if (match[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return tagRegex.lastIndex;
    } else {
      depth += 1;
    }
  }

  return html.length;
}

function extractBodySummary(html: string): string {
  const bodyMatch = /<div\b[^>]*\bclass="[^"]*\bc-article-body\b[^"]*"[^>]*>/i.exec(html);
  const scope = bodyMatch ? html.slice(bodyMatch.index + bodyMatch[0].length) : html;
  const sectionRegex = /<div\b[^>]*\bclass="[^"]*\bc-article-section__content\b[^"]*"[^>]*>/gi;
  let match: RegExpExecArray | null;

  while ((match = sectionRegex.exec(scope)) !== null) {
    const end = findClosingDiv(scope, match.index);
    const text = stripHtml(scope.slice(match.index + match[0].length, end));
    // Corrections start with a "Correction to: <DOI>" metadata block; the actual
    // correction text follows in the next section.
    if (!text || /^correction to:/i.test(text)) continue;
    if (text.length >= 40) return text;
  }

  return '';
}

export function extractArticleSummary(html: string): string {
  if (!html) return '';

  const meta = extractMetaSummary(html);
  if (meta) return truncate(meta);

  return truncate(extractBodySummary(html));
}

/**
 * Fetch the Nature article page and return its English abstract/standfirst.
 * Returns `null` when the fetch fails (so callers can retry later) and an empty
 * string when the page was fetched but carries no summary.
 */
export async function fetchArticleSummary(url: string, timeoutMs: number = 10000): Promise<string | null> {
  if (!url) return null;

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

    if (!res.ok) return null;

    const html = await res.text();
    return extractArticleSummary(html);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
