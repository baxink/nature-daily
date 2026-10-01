import { getEnabledSources, getSourceById, type MediaSource } from './sources';
import { normalizeArticles, type NormalizedArticle } from './normalize';
import { fetchRss } from './fetchers/rss';
import { fetchHtml } from './fetchers/html';
import { fetchArticleSummary } from './fetchers/article';
import { containsChinese, translateToChinese } from './translation';

interface Env {
  DB: D1Database;
  AI: Ai;
  FRONTEND_ORIGIN: string;
  FREE_API_KEY?: string;
  INGEST_TOKEN?: string;
  AI_MODEL?: string;
}

interface IngestRow {
  id: string;
  started_at: string;
  finished_at: string;
  status: string;
  success_count: number;
  failure_count: number;
}

interface DailyDigestCardRow {
  digest_date: string;
  source_id: string;
  section: string;
  article_id: string | null;
  title_en: string | null;
  title_zh: string | null;
  summary_en: string | null;
  summary_zh: string | null;
  url: string | null;
  image_url: string | null;
  published_at: string | null;
  selected_at: string;
  is_empty: number;
}

interface LegacyDailyDigestRow {
  digest_date: string;
  article_id: string;
  source_id: string;
  section: string;
  title_en: string;
  title_zh: string;
  summary_en: string;
  summary_zh: string;
  url: string;
  image_url: string | null;
  published_at: string | null;
  selected_at: string;
}

interface DailyDigestCardPayload {
  digestDate: string;
  sourceId: string;
  section: string;
  sectionKey: string;
  mediaName: string;
  title: string;
  titleEn: string;
  summary: string;
  summaryEn: string;
  url: string;
  imageUrl: string;
  publishedAt: string | null;
  selectedAt: string;
  isEmpty: boolean;
}

interface DailyDigestPayload {
  digestDate: string;
  cards: DailyDigestCardPayload[];
}

const DEFAULT_FRONTEND_ORIGIN = 'https://baxink.github.io';

function getConfiguredFrontendOrigin(env: Env): string {
  return env.FRONTEND_ORIGIN || DEFAULT_FRONTEND_ORIGIN;
}

function getOrderedSources(): MediaSource[] {
  return [...getEnabledSources()].sort((a, b) => a.priority - b.priority);
}

function isAllowedOrigin(origin: string, allowedOrigin: string): boolean {
  try {
    return new URL(origin).origin === new URL(allowedOrigin).origin;
  } catch {
    return false;
  }
}

function getCorsOrigin(request: Request, env: Env): string | null {
  const origin = request.headers.get('Origin');
  const allowedOrigin = getConfiguredFrontendOrigin(env);

  if (!origin) return allowedOrigin;
  return isAllowedOrigin(origin, allowedOrigin) ? origin : null;
}

function hasDisallowedOrigin(request: Request, env: Env): boolean {
  return request.headers.has('Origin') && !getCorsOrigin(request, env);
}

function corsHeaders(origin: string | null, cacheControl = 'public, max-age=300'): Record<string, string> {
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': cacheControl,
    'Vary': 'Origin',
  };

  if (origin) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function jsonResponse(request: Request, env: Env, body: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(getCorsOrigin(request, env), request.method !== 'GET' || status >= 400 ? 'no-store' : 'public, max-age=300'),
    },
  });
}

function forbiddenResponse(request: Request, env: Env): Response {
  return jsonResponse(request, env, { error: 'Forbidden origin' }, 403);
}

function ingestAuthorizationError(request: Request, env: Env): Response | null {
  if (!env.INGEST_TOKEN) {
    return jsonResponse(request, env, { error: 'Ingest is not configured' }, 503);
  }

  if (request.headers.get('Authorization') !== `Bearer ${env.INGEST_TOKEN}`) {
    return jsonResponse(request, env, { error: 'Unauthorized' }, 401);
  }

  return null;
}

function toDigestDate(date: Date = new Date()): string {
  // The report is generated at Beijing 06:00, so the digest day rolls over then.
  const offsetMs = 2 * 60 * 60 * 1000;
  return new Date(date.getTime() + offsetMs).toISOString().slice(0, 10);
}

function normalizeSectionLabel(section: string): string {
  return section
    .split('-')
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

/**
 * Resolve the English summary for an article. The listing page rarely carries
 * the abstract, so fetch the article page and fall back to any listing text.
 * A `null` result means the article page could not be fetched and should be
 * retried on the next ingest; `''` means the page has no summary to show.
 */
async function resolveArticleSummary(article: NormalizedArticle): Promise<string | null> {
  const listing = article.summary?.trim() || '';
  let remote: string | null = null;

  try {
    remote = await fetchArticleSummary(article.url);
  } catch (error) {
    console.error(`[summary] fetch failed for ${article.url}: ${String(error)}`);
  }

  if (remote === null) return listing || null;
  return remote || listing;
}

function buildEmptyCardRow(source: MediaSource, digestDate: string, selectedAt: string = new Date().toISOString()): DailyDigestCardRow {
  return {
    digest_date: digestDate,
    source_id: source.id,
    section: source.section,
    article_id: null,
    title_en: null,
    title_zh: null,
    summary_en: null,
    summary_zh: null,
    url: null,
    image_url: null,
    published_at: null,
    selected_at: selectedAt,
    is_empty: 1,
  };
}

function mapDigestCardRow(source: MediaSource, row: DailyDigestCardRow): DailyDigestCardPayload {
  return {
    digestDate: row.digest_date,
    sourceId: source.id,
    section: normalizeSectionLabel(source.section),
    sectionKey: source.section,
    mediaName: source.mediaName,
    title: row.title_zh || row.title_en || '',
    titleEn: row.title_en || '',
    summary: row.summary_zh || row.summary_en || '',
    summaryEn: row.summary_en || '',
    url: row.url || '',
    imageUrl: row.image_url || '',
    publishedAt: row.published_at,
    selectedAt: row.selected_at,
    isEmpty: row.is_empty === 1,
  };
}

function buildDigestPayload(sources: MediaSource[], rows: DailyDigestCardRow[], digestDate: string): DailyDigestPayload {
  const rowBySourceId = new Map(rows.map(row => [row.source_id, row]));

  return {
    digestDate,
    cards: sources.map(source => mapDigestCardRow(
      source,
      rowBySourceId.get(source.id) || buildEmptyCardRow(source, digestDate)
    )),
  };
}

function mapLegacyDigestRowToCard(row: LegacyDailyDigestRow): DailyDigestCardRow {
  return {
    digest_date: row.digest_date,
    source_id: row.source_id,
    section: row.section,
    article_id: row.article_id,
    title_en: row.title_en,
    title_zh: row.title_zh,
    summary_en: row.summary_en,
    summary_zh: row.summary_zh,
    url: row.url,
    image_url: row.image_url,
    published_at: row.published_at,
    selected_at: row.selected_at,
    is_empty: 0,
  };
}

async function fetchArticles(source: MediaSource): Promise<NormalizedArticle[]> {
  const raw = source.parserType === 'html'
    ? await fetchHtml(source.feedUrl)
    : await fetchRss(source.feedUrl);

  if (raw.length === 0) return [];

  return normalizeArticles(
    raw,
    source.id,
    source.country,
    source.mediaName,
    source.language,
    source.articleLimit
  );
}

async function upsertArticles(env: Env, articles: NormalizedArticle[]): Promise<void> {
  if (articles.length === 0) return;

  const stmts = articles.map(article =>
    env.DB.prepare(
      `INSERT OR REPLACE INTO articles (id, source_id, country, media_name, title, summary, url, image_url, published_at, fetched_at, lang, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).bind(
      article.id,
      article.sourceId,
      article.country,
      article.mediaName,
      article.title,
      article.summary,
      article.url,
      article.imageUrl,
      article.publishedAt,
      article.fetchedAt,
      article.lang
    )
  );

  await env.DB.batch(stmts);
}

async function upsertDigestCard(env: Env, row: DailyDigestCardRow): Promise<DailyDigestCardRow> {
  await env.DB.prepare(
    `INSERT OR REPLACE INTO daily_digest_cards (
      digest_date, source_id, section, article_id, title_en, title_zh, summary_en, summary_zh, url, image_url, published_at, selected_at, is_empty
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    row.digest_date,
    row.source_id,
    row.section,
    row.article_id,
    row.title_en,
    row.title_zh,
    row.summary_en,
    row.summary_zh,
    row.url,
    row.image_url,
    row.published_at,
    row.selected_at,
    row.is_empty
  ).run();

  return row;
}

async function fetchDigestCardsByDate(env: Env, digestDate: string): Promise<DailyDigestCardRow[]> {
  const rows = await env.DB.prepare(
    'SELECT * FROM daily_digest_cards WHERE digest_date = ?'
  ).bind(digestDate).all<DailyDigestCardRow>();

  return rows.results || [];
}

async function fetchDigestCard(env: Env, digestDate: string, sourceId: string): Promise<DailyDigestCardRow | null> {
  return env.DB.prepare(
    'SELECT * FROM daily_digest_cards WHERE digest_date = ? AND source_id = ? LIMIT 1'
  ).bind(digestDate, sourceId).first<DailyDigestCardRow>();
}

async function fetchLegacyDigestByDate(env: Env, digestDate: string): Promise<LegacyDailyDigestRow | null> {
  return env.DB.prepare(
    'SELECT * FROM daily_digest WHERE digest_date = ? LIMIT 1'
  ).bind(digestDate).first<LegacyDailyDigestRow>();
}

async function selectDigestCardForSource(
  env: Env,
  source: MediaSource,
  articles: NormalizedArticle[],
  digestDate: string,
  excludeIds: Set<string> = new Set(),
  translations?: TranslationStats,
): Promise<DailyDigestCardRow | null> {
  const recentRows = await env.DB.prepare(
    'SELECT article_id FROM daily_digest_cards WHERE source_id = ? AND is_empty = 0 ORDER BY digest_date DESC LIMIT 14'
  ).bind(source.id).all<{ article_id: string | null }>();

  const recentIds = new Set(
    [...recentRows.results.map(row => row.article_id).filter((id): id is string => Boolean(id)), ...excludeIds]
  );

  const candidates = [...articles].sort((a, b) =>
    (Date.parse(b.publishedAt || '') || 0) - (Date.parse(a.publishedAt || '') || 0)
  );
  const eligibleCandidates = candidates.filter(article => !excludeIds.has(article.id));
  const selected = eligibleCandidates.find(article => !recentIds.has(article.id)) || eligibleCandidates[0];

  if (!selected) {
    if (candidates.length > 0) return null;
    return upsertDigestCard(env, buildEmptyCardRow(source, digestDate));
  }

  const summaryEn = await resolveArticleSummary(selected);

  let localized: { titleZh: string; summaryZh: string } = { titleZh: '', summaryZh: '' };
  if (translations) translations.attempted++;
  try {
    localized = await translateToChinese(env.AI, { title: selected.title, summary: summaryEn || '' }, env.AI_MODEL);
    if (translations) translations.succeeded++;
  } catch (error) {
    const code = translationErrorCode(error);
    if (translations) {
      translations.failed++;
      translations.errors.push(`${source.id}: ${code}`);
    }
    console.error(`[translation] failed for source=${source.id}: ${code}`);
  }

  return upsertDigestCard(env, {
    digest_date: digestDate,
    source_id: source.id,
    section: source.section,
    article_id: selected.id,
    title_en: selected.title,
    title_zh: localized.titleZh,
    summary_en: summaryEn,
    summary_zh: localized.summaryZh,
    url: selected.url,
    image_url: selected.imageUrl || null,
    published_at: selected.publishedAt,
    selected_at: new Date().toISOString(),
    is_empty: 0,
  });
}

function translationErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : 'unknown error';
  return message.slice(0, 160);
}

interface TranslationStats {
  attempted: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

function needsTranslation(row: DailyDigestCardRow): boolean {
  return !containsChinese(row.title_zh)
    || Boolean(row.summary_en?.trim() && !containsChinese(row.summary_zh))
    || Boolean(row.summary_zh?.trim() && !containsChinese(row.summary_zh));
}

/** A null summary_en means the article summary was never fetched; '' means the
 * article page was checked and had no summary, so it must not be retried. */
function needsSummaryFetch(row: DailyDigestCardRow): boolean {
  return row.summary_en === null && Boolean(row.url);
}

async function backfillDigestCard(
  env: Env,
  row: DailyDigestCardRow,
  summaryEn: string | null,
  localized: { titleZh: string; summaryZh: string },
): Promise<boolean> {
  if (!row.title_en?.trim()) return false;
  const result = await env.DB.prepare(
    'UPDATE daily_digest_cards SET title_zh = ?, summary_en = ?, summary_zh = ? WHERE digest_date = ? AND source_id = ? AND article_id = ? AND selected_at = ?'
  ).bind(
    localized.titleZh,
    summaryEn,
    localized.summaryZh || null,
    row.digest_date,
    row.source_id,
    row.article_id,
    row.selected_at
  ).run();
  const changes = (result as { meta?: { changes?: number } } | undefined)?.meta?.changes;
  return changes !== 0;
}

async function ensureDailyDigestCards(
  env: Env,
  sources: MediaSource[],
  articlesBySource: Map<string, NormalizedArticle[]>,
  digestDate: string
): Promise<{ cards: DailyDigestCardRow[]; translations: TranslationStats }> {
  const existingRows = await fetchDigestCardsByDate(env, digestDate);
  const rowBySourceId = new Map(existingRows.map(row => [row.source_id, row]));
  const translations: TranslationStats = { attempted: 0, succeeded: 0, failed: 0, errors: [] };

  for (const source of sources) {
    const existingRow = rowBySourceId.get(source.id);
    if (existingRow && existingRow.is_empty === 0) {
      const repairSummary = needsSummaryFetch(existingRow);
      if (!repairSummary && !needsTranslation(existingRow)) continue;
      if (!existingRow.title_en?.trim()) {
        translations.failed++;
        translations.errors.push(`${source.id}: missing English title`);
        continue;
      }
      translations.attempted++;
      try {
        const summaryEn = repairSummary ? await fetchArticleSummary(existingRow.url || '') : existingRow.summary_en;
        if (repairSummary && summaryEn === null) {
          throw new Error('Article summary fetch failed; existing translation preserved');
        }
        const localized = await translateToChinese(env.AI, {
          title: existingRow.title_en,
          summary: summaryEn || '',
        }, env.AI_MODEL);
        const updated = await backfillDigestCard(env, existingRow, summaryEn, localized);
        if (updated) {
          translations.succeeded++;
          rowBySourceId.set(source.id, {
            ...existingRow,
            title_zh: localized.titleZh,
            summary_en: summaryEn,
            summary_zh: localized.summaryZh || null,
          });
        }
      } catch (error) {
        const code = translationErrorCode(error);
        translations.failed++;
        translations.errors.push(`${source.id}: ${code}`);
        console.error(`[translation] backfill failed for source=${source.id}: ${code}`);
      }
      continue;
    }

    const row = await selectDigestCardForSource(
      env,
      source,
      articlesBySource.get(source.id) || [],
      digestDate,
      new Set(),
      translations,
    );
    if (row) {
      rowBySourceId.set(source.id, row);
    }
  }

  const cards = sources
    .map(source => rowBySourceId.get(source.id))
    .filter((row): row is DailyDigestCardRow => Boolean(row));
  return { cards, translations };
}

async function runIngest(env: Env): Promise<{
  runId: string;
  status: string;
  successCount: number;
  failureCount: number;
  totalSources: number;
  digestDate: string;
  digestCreated: boolean;
  translationAttempted: number;
  translationSucceeded: number;
  translationFailed: number;
  errors?: string[];
}> {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date().toISOString();

  await env.DB.prepare(
    'INSERT INTO ingest_runs (id, started_at, status) VALUES (?, ?, ?)'
  ).bind(runId, startedAt, 'running').run();

  const sources = getOrderedSources();
  const articlesBySource = new Map<string, NormalizedArticle[]>();
  let successCount = 0;
  let failureCount = 0;
  const errors: string[] = [];

  for (const source of sources) {
    try {
      const sourceArticles = await fetchArticles(source);
      articlesBySource.set(source.id, sourceArticles);

      if (sourceArticles.length === 0) {
        failureCount++;
        errors.push(`${source.id}: no articles`);
        continue;
      }

      await upsertArticles(env, sourceArticles);
      successCount++;
    } catch (error) {
      failureCount++;
      errors.push(`${source.id}: ${String(error)}`);
      articlesBySource.set(source.id, []);
    }
  }

  const digestDate = toDigestDate();
  const { cards, translations } = await ensureDailyDigestCards(env, sources, articlesBySource, digestDate);
  errors.push(...translations.errors.map(error => `translation: ${error}`));
  const status = successCount > 0 ? 'success' : 'failed';
  const finishedAt = new Date().toISOString();

  await env.DB.prepare(
    'UPDATE ingest_runs SET finished_at = ?, status = ?, success_count = ?, failure_count = ?, notes = ? WHERE id = ?'
  ).bind(finishedAt, status, successCount, failureCount, errors.join('\n') || null, runId).run();

  await env.DB.prepare(
    "DELETE FROM articles WHERE fetched_at < datetime('now', '-30 days')"
  ).run();

  return {
    runId,
    status,
    successCount,
    failureCount,
    totalSources: sources.length,
    digestDate,
    digestCreated: cards.length > 0,
    translationAttempted: translations.attempted,
    translationSucceeded: translations.succeeded,
    translationFailed: translations.failed,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function handleDaily(env: Env, request: Request): Promise<Response> {
  const today = toDigestDate();
  const sources = getOrderedSources();
  const rows = await fetchDigestCardsByDate(env, today);

  if (rows.length === 0) {
    const legacyDigest = await fetchLegacyDigestByDate(env, today);
    if (!legacyDigest) {
      return jsonResponse(request, env, { error: 'Daily digest not ready' }, 404);
    }

    return jsonResponse(request, env, buildDigestPayload(sources, [mapLegacyDigestRowToCard(legacyDigest)], today));
  }

  return jsonResponse(request, env, buildDigestPayload(sources, rows, today));
}

async function handleMeta(env: Env, request: Request): Promise<Response> {
  const configuredSourceCount = getOrderedSources().length;

  const lastRun = await env.DB.prepare(
    'SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 1'
  ).first<IngestRow>();

  const articleCount = await env.DB.prepare(
    'SELECT COUNT(*) as count FROM articles'
  ).first<{ count: number }>();

  const digestCount = await env.DB.prepare(
    'SELECT COUNT(DISTINCT digest_date) as count FROM daily_digest_cards'
  ).first<{ count: number }>();

  return jsonResponse(request, env, {
    sourceCount: configuredSourceCount,
    articleCount: articleCount?.count || 0,
    digestCount: digestCount?.count || 0,
    lastUpdate: lastRun?.finished_at || lastRun?.started_at || null,
    lastRunStatus: lastRun?.status || null,
  });
}

async function handleIngest(env: Env, request: Request): Promise<Response> {
  const result = await runIngest(env);
  return jsonResponse(request, env, result);
}

async function parseRefreshRequest(request: Request): Promise<{ sourceId: string } | null> {
  try {
    const body = await request.json() as { sourceId?: string };
    if (!body?.sourceId || typeof body.sourceId !== 'string') return null;
    return { sourceId: body.sourceId };
  } catch {
    return null;
  }
}

async function handleRefresh(env: Env, request: Request): Promise<Response> {
  const payload = await parseRefreshRequest(request);
  if (!payload) {
    return jsonResponse(request, env, { error: 'sourceId is required' }, 400);
  }

  const source = getSourceById(payload.sourceId);
  if (!source || !source.enabled) {
    return jsonResponse(request, env, { error: 'Unknown sourceId' }, 404);
  }

  const today = toDigestDate();
  const existingCard = await fetchDigestCard(env, today, source.id);
  const excludeIds = new Set<string>();
  if (existingCard?.article_id) {
    excludeIds.add(existingCard.article_id);
  }

  let sourceArticles: NormalizedArticle[] = [];
  try {
    sourceArticles = await fetchArticles(source);
    await upsertArticles(env, sourceArticles);
  } catch (error) {
    console.error(`[refresh] ${source.id}: ${String(error)}`);
  }

  let card: DailyDigestCardRow;
  if (sourceArticles.length === 0 && existingCard && existingCard.is_empty === 0) {
    card = existingCard;
  } else {
    card = await selectDigestCardForSource(env, source, sourceArticles, today, excludeIds) || existingCard || buildEmptyCardRow(source, today);
  }

  return jsonResponse(request, env, mapDigestCardRow(source, card));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      if (hasDisallowedOrigin(request, env)) {
        return forbiddenResponse(request, env);
      }

      return new Response(null, {
        headers: corsHeaders(getCorsOrigin(request, env)),
      });
    }

    if (url.pathname === '/api/daily' && request.method === 'GET') {
      return handleDaily(env, request);
    }

    if (url.pathname === '/api/meta' && request.method === 'GET') {
      return handleMeta(env, request);
    }

    if (url.pathname === '/api/ingest' && request.method === 'POST') {
      if (hasDisallowedOrigin(request, env)) {
        return forbiddenResponse(request, env);
      }

      const authorizationError = ingestAuthorizationError(request, env);
      if (authorizationError) return authorizationError;

      return handleIngest(env, request);
    }

    if (url.pathname === '/api/daily/refresh' && request.method === 'POST') {
      if (hasDisallowedOrigin(request, env)) {
        return forbiddenResponse(request, env);
      }

      return handleRefresh(env, request);
    }

    return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  },

  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    await runIngest(env);
  },
};
