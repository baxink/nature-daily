import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { buildSync } = require('../node_modules/esbuild/lib/main.js');

async function loadModule(relativePath) {
  const entryPoint = new URL(relativePath, import.meta.url);
  const result = buildSync({
    entryPoints: [entryPoint.pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });

  const code = result.outputFiles[0].text;
  const encoded = Buffer.from(code).toString('base64');
  return import(`data:text/javascript;base64,${encoded}`);
}

function createDailyCard(row) {
  return {
    digest_date: row.digest_date,
    source_id: row.source_id,
    section: row.section,
    article_id: row.article_id ?? null,
    title_en: row.title_en ?? null,
    title_zh: row.title_zh ?? null,
    summary_en: row.summary_en ?? null,
    summary_zh: row.summary_zh ?? null,
    url: row.url ?? null,
    image_url: row.image_url ?? '',
    published_at: row.published_at ?? null,
    selected_at: row.selected_at,
    is_empty: row.is_empty ?? 0,
    media_name: row.media_name ?? null,
  };
}

function createDbMock(state) {
  const queries = [];
  const getCardsForDate = (digestDate) => [...(state.dailyCardsByDate.get(digestDate)?.values() || [])];
  const getCard = (digestDate, sourceId) => state.dailyCardsByDate.get(digestDate)?.get(sourceId) || null;
  const getLegacyDigest = (digestDate) => state.legacyDailyDigestByDate?.get(digestDate) || null;
  const setCard = (row) => {
    if (!state.dailyCardsByDate.has(row.digest_date)) {
      state.dailyCardsByDate.set(row.digest_date, new Map());
    }
    state.dailyCardsByDate.get(row.digest_date).set(row.source_id, createDailyCard(row));
  };

  return {
    queries,
    async batch(statements) {
      for (const statement of statements) {
        if (typeof statement.run === 'function') {
          await statement.run();
        }
      }
      return [];
    },
    prepare(sql) {
      const createStatement = (params = []) => ({
        async first() {
          queries.push({ sql, params, method: 'first' });

          if (sql.includes('SELECT COUNT(*) as count FROM media_sources WHERE enabled = 1')) {
            return { count: state.metaSourceCount ?? 0 };
          }

          if (sql.includes('SELECT COUNT(*) as count FROM articles')) {
            return { count: state.metaArticleCount ?? 0 };
          }

          if (sql.includes('SELECT COUNT(DISTINCT digest_date) as count FROM daily_digest_cards')) {
            return { count: state.metaDigestCount ?? 0 };
          }

          if (sql.includes('SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 1')) {
            return state.lastRun ?? null;
          }

          if (sql.includes('SELECT * FROM daily_digest_cards WHERE digest_date = ? AND source_id = ? LIMIT 1')) {
            return getCard(params[0], params[1]);
          }

          if (sql.includes('SELECT d.*, a.media_name') && sql.includes('WHERE d.digest_date = ? AND d.source_id = ?')) {
            return getCard(params[0], params[1]);
          }

          if (sql.includes('SELECT article_id FROM daily_digest_cards WHERE digest_date = ? AND source_id = ? LIMIT 1')) {
            const row = getCard(params[0], params[1]);
            return row ? { article_id: row.article_id } : null;
          }

          if (sql.includes('SELECT d.*, a.media_name') && sql.includes('FROM daily_digest d') && sql.includes('WHERE d.digest_date = ?')) {
            return getLegacyDigest(params[0]);
          }

          if (sql.includes('SELECT * FROM daily_digest WHERE digest_date = ? LIMIT 1')) {
            return getLegacyDigest(params[0]);
          }

          return null;
        },
        async all() {
          queries.push({ sql, params, method: 'all' });

          if (sql.includes('SELECT article_id FROM daily_digest_cards WHERE source_id = ?')) {
            return {
              results: state.recentArticleIdsBySource.get(params[0]) || [],
            };
          }

          if (sql.includes('SELECT d.*, a.media_name') && sql.includes('WHERE d.digest_date = ?')) {
            return {
              results: getCardsForDate(params[0]),
            };
          }

          if (sql.includes('SELECT * FROM daily_digest_cards WHERE digest_date = ?')) {
            return {
              results: getCardsForDate(params[0]),
            };
          }

          return { results: [] };
        },
        async run() {
          queries.push({ sql, params, method: 'run' });

          if (sql.includes('UPDATE daily_digest_cards SET title_zh = ?, summary_en = ?, summary_zh = ?')) {
            const [titleZh, summaryEn, summaryZh, digestDate, sourceId, articleId, selectedAt] = params;
            const row = getCard(digestDate, sourceId);
            const matches = row && row.article_id === articleId && row.selected_at === selectedAt;
            if (matches) setCard({ ...row, title_zh: titleZh, summary_en: summaryEn, summary_zh: summaryZh });
            return { success: true, meta: { changes: matches ? 1 : 0 } };
          }

          if (sql.includes('INSERT OR REPLACE INTO daily_digest_cards')) {
            const [digestDate, sourceId, section, articleId, titleEn, titleZh, summaryEn, summaryZh, url, imageUrl, publishedAt, selectedAt, isEmpty] = params;
            setCard({
              digest_date: digestDate,
              source_id: sourceId,
              section,
              article_id: articleId,
              title_en: titleEn,
              title_zh: titleZh,
              summary_en: summaryEn,
              summary_zh: summaryZh,
              url,
              image_url: imageUrl,
              published_at: publishedAt,
              selected_at: selectedAt,
              is_empty: isEmpty,
              media_name: state.mediaNameBySource.get(sourceId) || 'Nature',
            });
            return { success: true };
          }

          return { success: true };
        },
      });

      return {
        bind(...params) {
          return createStatement(params);
        },
        ...createStatement(),
      };
    },
  };
}

function installFixedDate(isoString) {
  const RealDate = globalThis.Date;
  const fixedTime = new RealDate(isoString).getTime();

  globalThis.Date = class FixedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixedTime);
        return;
      }
      super(...args);
    }

    static now() {
      return fixedTime;
    }
  };

  return () => {
    globalThis.Date = RealDate;
  };
}

function currentDigestDate() {
  return new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

test('rejects write requests from untrusted origins', async () => {
  const mod = await loadModule('../src/index.ts');
  const env = {
    DB: {
      prepare() {
        throw new Error('DB should not be used for rejected writes');
      },
    },
    AI: {
      run() {
        throw new Error('AI should not be used for rejected writes');
      },
    },
    FRONTEND_ORIGIN: 'https://baxink.github.io',
  };

  const request = new Request('https://example.com/api/ingest', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
  });

  const response = await mod.default.fetch(request, env);
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Forbidden/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('requires the configured bearer token for manual ingest regardless of Origin', async () => {
  const mod = await loadModule('../src/index.ts');
  const env = {
    DB: { prepare() { throw new Error('DB should not be used for unauthorized ingest'); } },
    AI: { run() { throw new Error('AI should not be used for unauthorized ingest'); } },
    FRONTEND_ORIGIN: 'https://baxink.github.io',
    INGEST_TOKEN: 'secret-ingest-token',
  };

  for (const headers of [{}, { Origin: 'https://baxink.github.io' }]) {
    const response = await mod.default.fetch(new Request('https://example.com/api/ingest', {
      method: 'POST',
      headers,
    }), env);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }

  const unconfiguredResponse = await mod.default.fetch(new Request('https://example.com/api/ingest', {
    method: 'POST',
  }), { ...env, INGEST_TOKEN: undefined });
  assert.equal(unconfiguredResponse.status, 503);
  assert.equal(unconfiguredResponse.headers.get('Cache-Control'), 'no-store');

  const state = {
    dailyCardsByDate: new Map(),
    recentArticleIdsBySource: new Map(),
    mediaNameBySource: new Map(),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<html><body></body></html>', { status: 200 });
  try {
    const authorizedResponse = await mod.default.fetch(new Request('https://example.com/api/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer secret-ingest-token' },
    }), {
      ...env,
      DB: createDbMock(state),
    });
    assert.equal(authorizedResponse.status, 200);
    const payload = await authorizedResponse.json();
    assert.equal(payload.totalSources, 7);
    assert.equal(payload.digestCreated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('reports the configured source count in meta even if the seeded table is stale', async () => {
  const mod = await loadModule('../src/index.ts');
  const env = {
    DB: createDbMock({
      dailyCardsByDate: new Map(),
      recentArticleIdsBySource: new Map(),
      mediaNameBySource: new Map(),
      metaSourceCount: 6,
      metaArticleCount: 42,
      metaDigestCount: 3,
      lastRun: {
        id: 'run_1',
        started_at: '2026-05-11T00:00:00.000Z',
        finished_at: '2026-05-11T00:05:00.000Z',
        status: 'success',
        success_count: 7,
        failure_count: 0,
      },
    }),
    AI: { run() { throw new Error('AI should not be used for meta'); } },
    FRONTEND_ORIGIN: 'https://baxink.github.io',
  };

  const response = await mod.default.fetch(new Request('https://example.com/api/meta'), env);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.sourceCount, 7);
  assert.equal(payload.articleCount, 42);
  assert.equal(payload.digestCount, 3);
});

test('uses the previous digest date before the Beijing 06:00 scheduled report time', async () => {
  const mod = await loadModule('../src/index.ts');
  const restoreDate = installFixedDate('2026-05-15T17:30:00.000Z');
  const state = {
    dailyCardsByDate: new Map([
      ['2026-05-15', new Map([['nature-news', createDailyCard({
        digest_date: '2026-05-15',
        source_id: 'nature-news',
        section: 'news',
        article_id: 'art_existing',
        title_en: 'Existing title',
        title_zh: '前一日报标题',
        summary_en: 'Existing summary',
        summary_zh: '前一日报摘要',
        url: 'https://www.nature.com/articles/existing',
        image_url: '',
        published_at: '2026-05-15T00:00:00.000Z',
        selected_at: '2026-05-15T22:00:00.000Z',
        is_empty: 0,
        media_name: 'Nature',
      })]])],
    ]),
    recentArticleIdsBySource: new Map(),
    mediaNameBySource: new Map([
      ['nature-news', 'Nature'],
    ]),
  };
  const db = createDbMock(state);
  const env = {
    DB: db,
    AI: { run() { throw new Error('AI should not be used for reads'); } },
    FRONTEND_ORIGIN: 'https://baxink.github.io',
  };

  try {
    const response = await mod.default.fetch(new Request('https://example.com/api/daily'), env);
    assert.equal(response.status, 200);

    const payload = await response.json();
    assert.equal(payload.digestDate, '2026-05-15');
    assert.equal(payload.cards.find(card => card.sourceId === 'nature-news').title, '前一日报标题');
  } finally {
    restoreDate();
  }
});

test('returns ordered daily cards and fills missing sources with empty placeholders', async () => {
  const mod = await loadModule('../src/index.ts');
  const today = currentDigestDate();
  const state = {
    dailyCardsByDate: new Map([
      [today, new Map([['nature-news', createDailyCard({
        digest_date: today,
        source_id: 'nature-news',
        section: 'news',
        article_id: 'art_existing',
        title_en: 'Existing title',
        title_zh: '现有标题',
        summary_en: 'Existing summary',
        summary_zh: '现有摘要',
        url: 'https://www.nature.com/articles/existing',
        image_url: '',
        published_at: '2026-05-11T00:00:00.000Z',
        selected_at: '2026-05-11T00:00:00.000Z',
        is_empty: 0,
        media_name: 'Nature',
      })]])],
    ]),
    recentArticleIdsBySource: new Map(),
    mediaNameBySource: new Map([
      ['nature-news', 'Nature'],
      ['nature-reviews-bioengineering', 'Nature Reviews Bioengineering'],
    ]),
  };
  const db = createDbMock(state);
  const env = {
    DB: db,
    AI: { run() { throw new Error('AI should not be used for reads'); } },
    FRONTEND_ORIGIN: 'https://baxink.github.io',
  };

  const response = await mod.default.fetch(new Request('https://example.com/api/daily'), env);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.digestDate, today);
  assert.equal(payload.cards.length, 7);
  assert.deepEqual(payload.cards.map(card => card.sourceId), [
    'nature-main-rss',
    'nature-news',
    'nature-opinion',
    'nature-research-analysis',
    'nature-research-articles',
    'nature-careers',
    'nature-reviews-bioengineering',
  ]);
  assert.equal(payload.cards[1].isEmpty, false);
  assert.equal(payload.cards[1].title, '现有标题');
  assert.equal(payload.cards[6].isEmpty, true);
  assert.equal(payload.cards[6].title, '');
});

test('ingest replaces a prior empty placeholder when a source later has an article', async () => {
  const mod = await loadModule('../src/index.ts');
  const today = currentDigestDate();
  const placeholder = createDailyCard({
      digest_date: today,
      source_id: 'nature-main-rss',
      section: 'main',
      article_id: null,
      title_en: null,
      title_zh: null,
      summary_en: null,
      summary_zh: null,
      url: null,
      image_url: '',
      published_at: null,
      selected_at: '2026-05-11T00:00:00.000Z',
      is_empty: 1,
    });
  const state = {
    dailyCardsByDate: new Map([[today, new Map([
      ['nature-main-rss', placeholder],
      ['nature-news', createDailyCard({
        digest_date: today,
        source_id: 'nature-news',
        section: 'news',
        article_id: 'existing-real-card',
        title_en: 'Keep this title',
        title_zh: '保留这篇日报',
        summary_en: 'Keep this summary',
        summary_zh: '保留摘要',
        url: 'https://www.nature.com/articles/keep',
        published_at: '2026-05-10T00:00:00.000Z',
        selected_at: '2026-05-10T00:00:00.000Z',
        is_empty: 0,
      })],
    ])]]),
    recentArticleIdsBySource: new Map(),
    mediaNameBySource: new Map([['nature-main-rss', 'Nature']]),
  };
  const db = createDbMock(state);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://www.nature.com/nature.rss') {
      return new Response(`<?xml version="1.0"?><rss version="2.0"><channel><item>
        <title>Recovered article</title><link>https://www.nature.com/articles/recovered</link>
        <description>Article summary</description><pubDate>Mon, 11 May 2026 00:00:00 GMT</pubDate>
      </item></channel></rss>`, { status: 200 });
    }
    return new Response('<html><body></body></html>', { status: 200 });
  };

  try {
    await mod.default.scheduled({}, {
      DB: db,
      AI: { run() { return { response: '{"titleZh":"恢复标题","summaryZh":"恢复摘要"}' }; } },
      FRONTEND_ORIGIN: 'https://baxink.github.io',
    });
    const recovered = state.dailyCardsByDate.get(today).get('nature-main-rss');
    assert.equal(recovered.is_empty, 0);
    assert.equal(recovered.title_en, 'Recovered article');
    const preserved = state.dailyCardsByDate.get(today).get('nature-news');
    assert.equal(preserved.article_id, 'existing-real-card');
    assert.equal(preserved.title_zh, '保留这篇日报');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('ingest backfills only Chinese fields for an existing card and skips it after successful translation', async () => {
  const mod = await loadModule('../src/index.ts');
  const restoreDate = installFixedDate('2026-05-15T04:00:00.000Z');
  const today = currentDigestDate();
  const original = createDailyCard({
    digest_date: today,
    source_id: 'nature-news',
    section: 'news',
    article_id: 'stable-article-id',
    title_en: 'A discovery in ocean science',
    title_zh: 'A discovery in ocean science',
    summary_en: 'Researchers found a new pattern.',
    summary_zh: 'Researchers found a new pattern.',
    url: 'https://www.nature.com/articles/stable',
    image_url: 'https://www.nature.com/image.jpg',
    published_at: '2026-05-14T00:00:00.000Z',
    selected_at: '2026-05-14T01:00:00.000Z',
    is_empty: 0,
  });
  const state = {
    dailyCardsByDate: new Map([[today, new Map([['nature-news', original]])]]),
    recentArticleIdsBySource: new Map(),
    mediaNameBySource: new Map(),
  };
  const db = createDbMock(state);
  let aiCalls = 0;
  const env = {
    DB: db,
    AI: { async run(model) {
      aiCalls++;
      assert.equal(model, '@cf/custom/translation-model');
      return { response: '{"titleZh":"海洋科学的一项发现","summaryZh":"研究人员发现了一种新模式。"}' };
    } },
    AI_MODEL: '@cf/custom/translation-model',
    FRONTEND_ORIGIN: 'https://baxink.github.io',
    INGEST_TOKEN: 'test-token',
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('<rss version="2.0"><channel></channel></rss>', { status: 200 });

  try {
    const request = () => mod.default.fetch(new Request('https://example.com/api/ingest', {
      method: 'POST',
      headers: { Authorization: 'Bearer test-token' },
    }), env);
    const firstResponse = await request();
    assert.equal(firstResponse.status, 200);
    const firstResult = await firstResponse.json();
    assert.equal(firstResult.translationAttempted, 1);
    assert.equal(firstResult.translationSucceeded, 1);
    assert.equal(firstResult.translationFailed, 0);
    const translated = state.dailyCardsByDate.get(today).get('nature-news');
    assert.equal(translated.title_zh, '海洋科学的一项发现');
    assert.equal(translated.summary_zh, '研究人员发现了一种新模式。');
    for (const field of ['article_id', 'title_en', 'summary_en', 'url', 'image_url', 'published_at', 'selected_at']) {
      assert.equal(translated[field], original[field], `${field} must remain unchanged`);
    }
    const update = db.queries.find(query => query.sql.includes('UPDATE daily_digest_cards SET title_zh = ?, summary_en = ?, summary_zh = ?'));
    assert.match(update.sql, /article_id = \? AND selected_at = \?/);
    assert.deepEqual(update.params.slice(3), [today, 'nature-news', original.article_id, original.selected_at]);

    const secondResult = await (await request()).json();
    assert.equal(secondResult.translationAttempted, 0);
    assert.equal(secondResult.translationSucceeded, 0);
    assert.equal(aiCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    restoreDate();
  }
});

test('falls back to the legacy single digest row when card rows are not ready yet', async () => {
  const mod = await loadModule('../src/index.ts');
  const today = currentDigestDate();
  const state = {
    dailyCardsByDate: new Map(),
    legacyDailyDigestByDate: new Map([
      [today, {
        digest_date: today,
        article_id: 'art_legacy',
        source_id: 'nature-news',
        section: 'news',
        title_en: 'Legacy title',
        title_zh: '旧版标题',
        summary_en: 'Legacy summary',
        summary_zh: '旧版摘要',
        url: 'https://www.nature.com/articles/legacy',
        image_url: '',
        published_at: '2026-05-11T00:00:00.000Z',
        selected_at: '2026-05-11T00:00:00.000Z',
      }],
    ]),
    recentArticleIdsBySource: new Map(),
    mediaNameBySource: new Map([
      ['nature-news', 'Nature'],
    ]),
  };
  const db = createDbMock(state);
  const env = {
    DB: db,
    AI: { run() { throw new Error('AI should not be used for reads'); } },
    FRONTEND_ORIGIN: 'https://baxink.github.io',
  };

  const response = await mod.default.fetch(new Request('https://example.com/api/daily'), env);
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.cards.length, 7);
  const legacyCard = payload.cards.find(card => card.sourceId === 'nature-news');
  assert.ok(legacyCard);
  assert.equal(legacyCard.isEmpty, false);
  assert.equal(legacyCard.title, '旧版标题');
  assert.equal(legacyCard.url, 'https://www.nature.com/articles/legacy');
});

test('rejects refresh requests without a sourceId', async () => {
  const mod = await loadModule('../src/index.ts');
  const env = {
    DB: {
      prepare() {
        throw new Error('DB should not be used for invalid refresh requests');
      },
    },
    AI: {
      run() {
        throw new Error('AI should not be used for invalid refresh requests');
      },
    },
    FRONTEND_ORIGIN: 'https://baxink.github.io',
  };

  const response = await mod.default.fetch(new Request('https://example.com/api/daily/refresh', {
    method: 'POST',
    headers: {
      Origin: 'https://baxink.github.io',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  }), env);

  assert.equal(response.status, 400);
  assert.match(await response.text(), /sourceId/i);
});

test('refreshes only the targeted source card', async () => {
  const mod = await loadModule('../src/index.ts');
  const today = currentDigestDate();
  const state = {
    dailyCardsByDate: new Map([
      [today, new Map([
        ['nature-main-rss', createDailyCard({
          digest_date: today,
          source_id: 'nature-main-rss',
          section: 'main',
          article_id: 'art_old',
          title_en: 'Old main title',
          title_zh: '旧主刊标题',
          summary_en: 'Old main summary',
          summary_zh: '旧主刊摘要',
          url: 'https://www.nature.com/articles/old-main',
          image_url: '',
          published_at: '2026-05-01T00:00:00.000Z',
          selected_at: '2026-05-11T00:00:00.000Z',
          is_empty: 0,
          media_name: 'Nature',
        })],
        ['nature-news', createDailyCard({
          digest_date: today,
          source_id: 'nature-news',
          section: 'news',
          article_id: 'art_news',
          title_en: 'News title',
          title_zh: '新闻标题',
          summary_en: 'News summary',
          summary_zh: '新闻摘要',
          url: 'https://www.nature.com/articles/news',
          image_url: '',
          published_at: '2026-05-02T00:00:00.000Z',
          selected_at: '2026-05-11T00:00:00.000Z',
          is_empty: 0,
          media_name: 'Nature',
        })],
      ])],
    ]),
    recentArticleIdsBySource: new Map([
      ['nature-main-rss', [{ article_id: 'art_old' }]],
    ]),
    mediaNameBySource: new Map([
      ['nature-main-rss', 'Nature'],
      ['nature-news', 'Nature'],
    ]),
  };
  const db = createDbMock(state);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url === 'https://www.nature.com/nature.rss') {
      return new Response(`<?xml version="1.0"?>
        <rss version="2.0"><channel>
          <item>
            <title>Latest main article</title>
            <link>https://www.nature.com/articles/new-main</link>
            <description>Fresh summary</description>
            <pubDate>Mon, 11 May 2026 00:00:00 GMT</pubDate>
          </item>
          <item>
            <title>Older main article</title>
            <link>https://www.nature.com/articles/old-main</link>
            <description>Old summary</description>
            <pubDate>Sun, 10 May 2026 00:00:00 GMT</pubDate>
          </item>
        </channel></rss>`, { status: 200 });
    }

    return new Response('', { status: 200 });
  };

  try {
    const env = {
      DB: db,
      AI: {
        run() {
          return { response: '{"titleZh":"新主刊标题","summaryZh":"新主刊摘要"}' };
        },
      },
      FRONTEND_ORIGIN: 'https://baxink.github.io',
    };

    const response = await mod.default.fetch(new Request('https://example.com/api/daily/refresh', {
      method: 'POST',
      headers: {
        Origin: 'https://baxink.github.io',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sourceId: 'nature-main-rss' }),
    }), env);

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.sourceId, 'nature-main-rss');
    assert.equal(payload.url, 'https://www.nature.com/articles/new-main');
    assert.equal(payload.isEmpty, false);
    assert.equal(state.dailyCardsByDate.get(today).get('nature-news').url, 'https://www.nature.com/articles/news');
    assert.equal(state.dailyCardsByDate.get(today).get('nature-main-rss').url, 'https://www.nature.com/articles/new-main');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('keeps the current card when refresh finds no alternative article', async () => {
  const mod = await loadModule('../src/index.ts');
  const today = currentDigestDate();
  const originalCard = createDailyCard({
    digest_date: today,
    source_id: 'nature-main-rss',
    section: 'main',
    article_id: 'art_jmzix1',
    title_en: 'Only article',
    title_zh: '唯一文章',
    summary_en: 'Existing summary',
    summary_zh: '现有摘要',
    url: 'https://www.nature.com/articles/only',
    image_url: '',
    published_at: '2026-05-11T00:00:00.000Z',
    selected_at: '2026-05-11T00:00:00.000Z',
    is_empty: 0,
    media_name: 'Nature',
  });
  const state = {
    dailyCardsByDate: new Map([[today, new Map([['nature-main-rss', originalCard]])]]),
    recentArticleIdsBySource: new Map(),
    mediaNameBySource: new Map([['nature-main-rss', 'Nature']]),
  };
  const originalFetch = globalThis.fetch;
  let aiCalls = 0;
  globalThis.fetch = async () => new Response(`<?xml version="1.0"?><rss version="2.0"><channel><item>
    <title>Only article</title><link>https://www.nature.com/articles/only</link>
    <description>Existing summary</description><pubDate>Mon, 11 May 2026 00:00:00 GMT</pubDate>
  </item></channel></rss>`, { status: 200 });

  try {
    const response = await mod.default.fetch(new Request('https://example.com/api/daily/refresh', {
      method: 'POST',
      headers: { Origin: 'https://baxink.github.io', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'nature-main-rss' }),
    }), {
      DB: createDbMock(state),
      AI: { run() { aiCalls++; return { response: '{"titleZh":"唯一文章","summaryZh":"现有摘要"}' }; } },
      FRONTEND_ORIGIN: 'https://baxink.github.io',
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const payload = await response.json();
    assert.equal(payload.url, originalCard.url);
    assert.equal(payload.title, originalCard.title_zh);
    assert.equal(state.dailyCardsByDate.get(today).get('nature-main-rss').article_id, 'art_jmzix1');
    assert.equal(aiCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('refresh excludes the current article but falls back to an older recently used candidate', async () => {
  const mod = await loadModule('../src/index.ts');
  const today = currentDigestDate();
  const state = {
    dailyCardsByDate: new Map([[today, new Map([['nature-main-rss', createDailyCard({
      digest_date: today,
      source_id: 'nature-main-rss',
      section: 'main',
      article_id: 'art_a0ob28',
      title_en: 'Current article',
      title_zh: '当前文章',
      summary_en: 'Current summary',
      summary_zh: '当前摘要',
      url: 'https://www.nature.com/articles/current',
      published_at: '2026-05-12T00:00:00.000Z',
      selected_at: '2026-05-12T00:00:00.000Z',
      is_empty: 0,
    })]])]]),
    recentArticleIdsBySource: new Map([['nature-main-rss', [{ article_id: 'art_nvr1ul' }]]]),
    mediaNameBySource: new Map([['nature-main-rss', 'Nature']]),
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`<?xml version="1.0"?><rss version="2.0"><channel>
    <item><title>Current article</title><link>https://www.nature.com/articles/current</link>
      <pubDate>Tue, 12 May 2026 00:00:00 GMT</pubDate></item>
    <item><title>Historical article</title><link>https://www.nature.com/articles/historical</link>
      <pubDate>Mon, 11 May 2026 00:00:00 GMT</pubDate></item>
  </channel></rss>`, { status: 200 });

  try {
    const response = await mod.default.fetch(new Request('https://example.com/api/daily/refresh', {
      method: 'POST',
      headers: { Origin: 'https://baxink.github.io', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceId: 'nature-main-rss' }),
    }), {
      DB: createDbMock(state),
      AI: { run() { return { response: '{"titleZh":"历史文章","summaryZh":"历史摘要"}' }; } },
      FRONTEND_ORIGIN: 'https://baxink.github.io',
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.url, 'https://www.nature.com/articles/historical');
    assert.equal(state.dailyCardsByDate.get(today).get('nature-main-rss').article_id, 'art_nvr1ul');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchHtml reads published time from nearby metadata', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(`
    <html>
      <body>
        <article>
          <time datetime="2024-01-15T12:34:56Z"></time>
          <a href="/articles/example-article">Nature Example article title long enough</a>
        </article>
      </body>
    </html>
  `, { status: 200 });

  try {
    const { fetchHtml } = await loadModule('../src/fetchers/html.ts');
    const [article] = await fetchHtml('https://www.nature.com/news');

    assert.ok(article);
    assert.equal(article.pubDate, '2024-01-15T12:34:56.000Z');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function translationState(overrides = {}) {
  const day = currentDigestDate();
  const card = createDailyCard({
    digest_date: day, source_id: 'nature-main-rss', section: 'main',
    article_id: 'original-id', title_en: 'Original title', title_zh: 'Original title',
    summary_en: '', summary_zh: 'Original title', url: 'https://www.nature.com/articles/original',
    selected_at: '2026-09-29T22:00:00.000Z', is_empty: 0, ...overrides,
  });
  return { dailyCardsByDate: new Map([[day, new Map([['nature-main-rss', card]])]]),
    recentArticleIdsBySource: new Map(), mediaNameBySource: new Map() };
}

async function runTranslationIngest(state, ai) {
  const mod = await loadModule('../src/index.ts');
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('');
  try {
    const response = await mod.default.fetch(new Request('https://example.com/api/ingest', {
      method: 'POST', headers: { Authorization: 'Bearer test-token' },
    }), { DB: createDbMock(state), AI: ai, INGEST_TOKEN: 'test-token' });
    assert.equal(response.status, 200);
    return response.json();
  } finally { globalThis.fetch = savedFetch; }
}

test('ingest repairs stored English without changing selection and skips repaired cards next time', async () => {
  const state = translationState();
  const cards = state.dailyCardsByDate.get(currentDigestDate());
  const before = { ...cards.get('nature-main-rss') };
  let calls = 0;
  const ai = { async run() { calls++; return { response: '{"titleZh":"原文标题","summaryZh":""}' }; } };
  const result = await runTranslationIngest(state, ai);
  assert.equal(result.translationSucceeded, 1);
  assert.deepEqual(cards.get('nature-main-rss'), { ...before, title_zh: '原文标题', summary_zh: null });
  const repeated = await runTranslationIngest(state, ai);
  assert.equal(repeated.translationAttempted, 0);
  assert.equal(calls, 1);
});

test('failed backfill preserves the original and a later ingest retries missing summaries', async () => {
  const state = translationState({ title_zh: '已有标题', summary_en: 'Real English summary', summary_zh: null });
  const cards = state.dailyCardsByDate.get(currentDigestDate());
  const before = { ...cards.get('nature-main-rss') };
  const failed = await runTranslationIngest(state, { async run() { throw new Error('model unavailable'); } });
  assert.equal(failed.translationFailed, 1);
  assert.match(failed.errors.join(' '), /model unavailable/);
  assert.deepEqual(cards.get('nature-main-rss'), before);
  const recovered = await runTranslationIngest(state, { async run() {
    return { response: '{"titleZh":"已有标题","summaryZh":"真实中文摘要"}' };
  } });
  assert.equal(recovered.translationSucceeded, 1);
  assert.equal(cards.get('nature-main-rss').summary_zh, '真实中文摘要');
});

test('ingest fetches the real English abstract for a card stored without a summary', async () => {
  const mod = await loadModule('../src/index.ts');
  const today = currentDigestDate();
  const card = createDailyCard({
    digest_date: today, source_id: 'nature-main-rss', section: 'main',
    article_id: 'art_correction', title_en: 'Author Correction: Proteasome-guided haem signalling',
    title_zh: '作者更正：蛋白酶体引导的血红素信号', summary_en: null, summary_zh: null,
    url: 'https://www.nature.com/articles/correction',
    selected_at: '2026-09-29T22:00:00.000Z', is_empty: 0,
  });
  const state = {
    dailyCardsByDate: new Map([[today, new Map([['nature-main-rss', card]])]]),
    recentArticleIdsBySource: new Map(), mediaNameBySource: new Map(),
  };
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === 'string' ? input : input.url;
    if (new URL(url).pathname === '/articles/correction') {
      return new Response('<html><head><meta name="description" content="In the version of the article initially published there were errors." /></head></html>', { status: 200 });
    }
    return new Response('', { status: 200 });
  };

  try {
    const response = await mod.default.fetch(new Request('https://example.com/api/ingest', {
      method: 'POST', headers: { Authorization: 'Bearer test-token' },
    }), { DB: createDbMock(state), AI: { async run() {
      return { response: '{"titleZh":"作者更正：蛋白酶体引导的血红素信号","summaryZh":"在最初发表的版本中，源数据存在错误。"}' };
    } }, INGEST_TOKEN: 'test-token' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.translationSucceeded, 1);
    const updated = state.dailyCardsByDate.get(today).get('nature-main-rss');
    assert.equal(updated.summary_en, 'In the version of the article initially published there were errors.');
    assert.equal(updated.summary_zh, '在最初发表的版本中，源数据存在错误。');
    assert.equal(updated.title_zh, '作者更正：蛋白酶体引导的血红素信号');
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('backfill does not put an old translation on a concurrently refreshed article', async () => {
  const state = translationState();
  const cards = state.dailyCardsByDate.get(currentDigestDate());
  const replacement = { ...cards.get('nature-main-rss'), article_id: 'replacement',
    url: 'https://www.nature.com/articles/replacement', title_zh: '新文章', selected_at: '2026-09-30T10:00:00Z' };
  const result = await runTranslationIngest(state, { async run() {
    cards.set('nature-main-rss', replacement);
    return { response: '{"titleZh":"旧文章译文","summaryZh":""}' };
  } });
  assert.deepEqual(cards.get('nature-main-rss'), replacement);
  assert.equal(result.translationSucceeded, 0);
});


test('failed summary fetching preserves Chinese fields and retries without a wasted AI call', async () => {
  const mod = await loadModule('../src/index.ts');
  const state = translationState({ title_zh: '已有中文标题', summary_en: null, summary_zh: '已有中文摘要' });
  const cards = state.dailyCardsByDate.get(currentDigestDate());
  const before = { ...cards.get('nature-main-rss') };
  const savedFetch = globalThis.fetch;
  let recovered = false;
  let calls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname === '/articles/original') return recovered
      ? new Response('<meta name="description" content="Recovered English summary.">')
      : new Response('unavailable', { status: 503 });
    return new Response('');
  };
  const env = { DB: createDbMock(state), INGEST_TOKEN: 'test-token', AI: { async run() {
    calls++; return { response: { titleZh: '已有中文标题', summaryZh: '恢复的中文摘要' } };
  } } };
  const ingest = () => mod.default.fetch(new Request('https://example.com/api/ingest', {
    method: 'POST', headers: { Authorization: 'Bearer test-token' },
  }), env);
  try {
    const failed = await (await ingest()).json();
    assert.equal(calls, 0);
    assert.equal(failed.translationFailed, 1);
    assert.deepEqual(cards.get('nature-main-rss'), before);
    recovered = true;
    const result = await (await ingest()).json();
    assert.equal(result.translationSucceeded, 1);
    assert.equal(calls, 1);
    assert.equal(cards.get('nature-main-rss').summary_en, 'Recovered English summary.');
  } finally { globalThis.fetch = savedFetch; }
});


test('a complete seven-source digest stays under the free external-request budget with Nature redirects', async () => {
  const mod = await loadModule('../src/index.ts');
  const state = { dailyCardsByDate: new Map(), recentArticleIdsBySource: new Map(), mediaNameBySource: new Map() };
  const savedFetch = globalThis.fetch;
  let externalRequests = 0;
  const spend = (count) => { externalRequests += count; if (externalRequests > 50) throw new Error('Too many subrequests'); };
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.startsWith('/articles/')) {
      spend(url.searchParams.get('error') === 'cookies_not_supported' ? 1 : 4);
      return new Response('<meta name="description" content="A real scientific article summary.">');
    }
    if (url.pathname.endsWith('.rss')) {
      spend(1);
      return new Response(`<rss><channel><item><title>A new scientific discovery</title><link>https://www.nature.com/articles/${url.pathname.includes('natrevbioeng') ? 'bioengineering' : 'main'}</link></item></channel></rss>`);
    }
    spend(4);
    return new Response(`<article><a href="/articles/${url.pathname.slice(1).replaceAll('/', '-')}">A new scientific discovery</a></article>`);
  };
  try {
    const response = await mod.default.fetch(new Request('https://example.com/api/ingest', {
      method: 'POST', headers: { Authorization: 'Bearer test-token' },
    }), { DB: createDbMock(state), INGEST_TOKEN: 'test-token', AI: { async run() {
      spend(1); return { response: { titleZh: '一项新的科学发现', summaryZh: '一篇真实的科学文章摘要。' } };
    } } });
    const result = await response.json();
    assert.equal(result.successCount, 7);
    assert.equal(result.translationSucceeded, 7);
    assert.equal(result.translationFailed, 0);
    assert.ok(externalRequests <= 50);
    assert.equal(state.dailyCardsByDate.get(currentDigestDate()).size, 7);
  } finally { globalThis.fetch = savedFetch; }
});
