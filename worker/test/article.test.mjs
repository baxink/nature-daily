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
  return import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
}

test('prefers the article meta description as the English summary', async () => {
  const { extractArticleSummary } = await loadModule('../src/fetchers/article.ts');
  const html = `
    <html><head>
      <meta name="twitter:description" content="Nature - Short teaser only" />
      <meta name="dc.description" content="Diet shapes the composition of the gut microbiota." />
      <meta name="description" content="Full abstract from the article page." />
      <meta property="og:description" content="Short open graph teaser." />
    </head><body></body></html>
  `;

  assert.equal(extractArticleSummary(html), 'Full abstract from the article page.');
});

test('falls back to the open graph description when description is empty', async () => {
  const { extractArticleSummary } = await loadModule('../src/fetchers/article.ts');
  const html = `
    <html><head>
      <meta name="description" content="" />
      <meta property="og:description" content="Tools must be tested in real-world settings." />
    </head><body></body></html>
  `;

  assert.equal(extractArticleSummary(html), 'Tools must be tested in real-world settings.');
});

test('ignores the "Nature - title" twitter teaser and reads the correction body', async () => {
  const { extractArticleSummary } = await loadModule('../src/fetchers/article.ts');
  const html = `
    <html><head>
      <meta name="description" content="" />
      <meta name="dc.description" content="" />
      <meta name="twitter:description" content="Nature - Author Correction: Proteasome-guided haem signalling" />
    </head><body>
      <div class="c-article-body">
        <div class="c-article-section__content"><p>Correction to: <i>Nature</i> <a href="https://doi.org/10.1038/x">https://doi.org/10.1038/x</a> Published online 18 March 2026</p></div>
        <div class="c-article-section__content"><p>In the version of the article initially published, there were several copy-paste errors in the source data for Figs. 1p and 3h.</p></div>
      </div>
    </body></html>
  `;

  assert.equal(
    extractArticleSummary(html),
    'In the version of the article initially published, there were several copy-paste errors in the source data for Figs. 1p and 3h.',
  );
});

test('extracts the abstract section from a research article body', async () => {
  const { extractArticleSummary } = await loadModule('../src/fetchers/article.ts');
  const html = `
    <html><body>
      <div class="c-article-body">
        <div class="c-article-section__content" id="Abs1-content"><p>Diet and antibiotics interact to reshape the gut microbiome in hospitalized patients.</p></div>
      </div>
    </body></html>
  `;

  assert.equal(
    extractArticleSummary(html),
    'Diet and antibiotics interact to reshape the gut microbiome in hospitalized patients.',
  );
});

test('fetchArticleSummary returns null on failure and an empty string when no summary exists', async () => {
  const { fetchArticleSummary } = await loadModule('../src/fetchers/article.ts');
  const originalFetch = globalThis.fetch;

  try {
    globalThis.fetch = async () => new Response('nope', { status: 503 });
    assert.equal(await fetchArticleSummary('https://www.nature.com/articles/x'), null);

    globalThis.fetch = async () => { throw new Error('offline'); };
    assert.equal(await fetchArticleSummary('https://www.nature.com/articles/x'), null);

    globalThis.fetch = async () => new Response('<html><body>no summary here</body></html>', { status: 200 });
    assert.equal(await fetchArticleSummary('https://www.nature.com/articles/x'), '');

    globalThis.fetch = async () => new Response(
      '<html><head><meta name="description" content="Real abstract." /></head><body></body></html>',
      { status: 200 },
    );
    assert.equal(await fetchArticleSummary('https://www.nature.com/articles/x'), 'Real abstract.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
