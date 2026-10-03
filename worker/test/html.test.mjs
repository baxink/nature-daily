import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { buildSync } = require('../node_modules/esbuild/lib/main.js');

async function loadModule(path) {
  const entryPoint = new URL(path, import.meta.url);
  const result = buildSync({
    entryPoints: [entryPoint.pathname],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    write: false,
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
}

async function fetchFromHtml(html) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(html, { status: 200 });
  try {
    const { fetchHtml } = await loadModule('../src/fetchers/html.ts');
    return await fetchHtml('https://www.nature.com/news');
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test('extracts each publication date from its own article card', async () => {
  const articles = await fetchFromHtml(`
    <main>
      <article><time datetime="2024-01-15T12:34:56Z"></time>
        <a href="/articles/first">First Nature article title is long enough</a></article>
      <article><a href="/articles/second">Second Nature article title is long enough</a>
        <meta property="article:published_time" content="2025-02-16T08:00:00Z"></article>
    </main>
  `);

  assert.deepEqual(articles.map(({ pubDate }) => pubDate), [
    '2024-01-15T12:34:56.000Z',
    '2025-02-16T08:00:00.000Z',
  ]);
});

test('normalizes missing and invalid publication dates to null and preserves valid dates', async () => {
  const { normalizeArticles } = await loadModule('../src/normalize.ts');
  const [valid, missing, invalid] = normalizeArticles([
    { title: 'Valid date', link: 'https://www.nature.com/articles/valid', pubDate: '2024-03-04T05:06:07Z' },
    { title: 'Missing date', link: 'https://www.nature.com/articles/missing' },
    { title: 'Invalid date', link: 'https://www.nature.com/articles/invalid', pubDate: 'not-a-date' },
  ], 'nature', 'GB', 'Nature', 'en', 10);

  assert.equal(valid.publishedAt, '2024-03-04T05:06:07.000Z');
  assert.equal(missing.publishedAt, null);
  assert.equal(invalid.publishedAt, null);
});

test('does not infer publication dates from Nature article identifiers', async () => {
  const [article] = await fetchFromHtml(`
    <article><a href="/articles/example-2024-07-12345-a">Nature article identifier title long enough</a></article>
  `);

  assert.ok(article);
  assert.equal(article.pubDate, undefined);
});

test('rejects lookalike hosts and non-HTTP article URLs', async () => {
  const articles = await fetchFromHtml(`
    <article><a href="https://evilnature.com/articles/evil">This malicious title is long enough to pass</a></article>
    <article><a href="ftp://www.nature.com/articles/ftp">This FTP title is also long enough</a></article>
    <article><a href="https://nature.com/articles/valid">This valid Nature title is long enough</a></article>
  `);

  assert.deepEqual(articles.map(({ link }) => link), ['https://nature.com/articles/valid']);
});


test('reads only the heading when a Nature article link wraps a whole card', async () => {
  const [article] = await fetchFromHtml(`
    <article><a href="/articles/d41586-026-02201-4">
      <div class="c-article-item__copy">
        <h3 class="c-article-item__title">I turn up late to meetings to dodge small talk. Am I wrong?</h3>
        <div class="c-article-item__standfirst"><p>A jury weighs in on this question.</p></div>
        <div class="c-article-item__footer">Career Feature | 30 SEP 2026</div>
      </div>
    </a></article>
  `);
  assert.equal(article.title, 'I turn up late to meetings to dodge small talk. Am I wrong?');
});


test('preserves Nature when it is a word in the actual article title', async () => {
  const [article] = await fetchFromHtml('<article><a href="/articles/nature-rights"><h3>Nature has rights — it is time the world recognized them</h3></a></article>');
  assert.equal(article.title, 'Nature has rights — it is time the world recognized them');
});
