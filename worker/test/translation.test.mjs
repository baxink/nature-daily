import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { buildSync } = require('../node_modules/esbuild/lib/main.js');
const built = buildSync({
  entryPoints: [new URL('../src/translation.ts', import.meta.url).pathname],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  write: false,
});
const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);

const input = { title: 'New discovery in ocean science', summary: 'Researchers found a new pattern in ocean circulation.' };

test('uses the configured model and accepts valid Chinese JSON', async () => {
  let usedModel;
  const result = await mod.translateToChinese({
    async run(model) {
      usedModel = model;
      return { response: '{"titleZh":"海洋科学的新发现","summaryZh":"研究人员发现了海洋环流的新模式。"}' };
    },
  }, input, '@cf/custom/model');
  assert.equal(usedModel, '@cf/custom/model');
  assert.deepEqual(result, { titleZh: '海洋科学的新发现', summaryZh: '研究人员发现了海洋环流的新模式。' });
});

test('defaults to the supported GLM model', async () => {
  let usedModel;
  await mod.translateToChinese({
    async run(model) {
      usedModel = model;
      return { response: '{"titleZh":"海洋科学的新发现","summaryZh":"研究人员发现了海洋环流的新模式。"}' };
    },
  }, input);
  assert.equal(usedModel, '@cf/zai-org/glm-4.7-flash');
});

test('rejects model errors, malformed JSON, null, non-string, empty, and English results', async (t) => {
  const invalidResponses = [
    { name: 'malformed JSON', response: '{broken' },
    { name: 'null JSON', response: 'null' },
    { name: 'non-string title', response: '{"titleZh":12,"summaryZh":"中文摘要"}' },
    { name: 'empty fields', response: '{"titleZh":" ","summaryZh":"中文摘要"}' },
    { name: 'English fields', response: '{"titleZh":"Ocean discovery","summaryZh":"Researchers found a new pattern."}' },
  ];
  await t.test('model unavailable', async () => {
    await assert.rejects(() => mod.translateToChinese({ async run() { throw new Error('unavailable'); } }, input), /unavailable/);
  });
  for (const item of invalidResponses) {
    await t.test(item.name, async () => {
      await assert.rejects(() => mod.translateToChinese({ async run() { return { response: item.response }; } }, input));
    });
  }
  await t.test('response value is null', async () => {
    await assert.rejects(() => mod.translateToChinese({ async run() { return { response: null }; } }, input), /not a string/);
  });
});

test('when no English summary exists, requests title-only translation and allows an empty summary', async () => {
  let request;
  const result = await mod.translateToChinese({
    async run(_model, payload) {
      request = payload;
      return { response: '{"titleZh":"海洋科学的新发现","summaryZh":""}' };
    },
  }, { title: input.title, summary: '' });
  assert.deepEqual(result, { titleZh: '海洋科学的新发现', summaryZh: '' });
  assert.match(request.messages[1].content, /只翻译标题/);
});

test('accepts structured response objects and OpenAI-compatible choices from current models', async () => {
  const input = { title: 'English title', summary: 'English summary' };
  const expected = { titleZh: '中文标题', summaryZh: '中文摘要' };
  for (const result of [{ response: expected }, { choices: [{ message: { content: JSON.stringify(expected) } }] }]) {
    assert.deepEqual(await mod.translateToChinese({ async run() { return result; } }, input), expected);
  }
});
