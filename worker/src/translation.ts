export interface TranslationInput {
  title: string;
  summary: string;
}

export interface ChineseTranslation {
  titleZh: string;
  summaryZh: string;
}

interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
}

const DEFAULT_AI_MODEL = '@cf/zai-org/glm-4.7-flash';
const HAN_CHARACTERS = /[\u3400-\u4dbf\u4e00-\u9fff]/;

export function containsChinese(value: string | null | undefined): boolean {
  return Boolean(value?.trim() && HAN_CHARACTERS.test(value));
}

function responseText(result: unknown): string {
  if (!result || typeof result !== 'object') {
    throw new Error('AI translation response is missing');
  }
  const output = result as { response?: unknown; choices?: Array<{ message?: { content?: unknown } }> };
  if (output.response && typeof output.response === 'object' && !Array.isArray(output.response)) {
    return JSON.stringify(output.response);
  }
  const response = typeof output.response === 'string'
    ? output.response : output.choices?.[0]?.message?.content;
  if (typeof response !== 'string' || !response.trim()) {
    throw new Error('AI translation response is empty or not a string');
  }
  return response.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
}

function parseTranslation(text: string, hasSummary: boolean): ChineseTranslation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('AI translation returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('AI translation JSON must be an object');
  }
  const value = parsed as Record<string, unknown>;
  if (typeof value.titleZh !== 'string' || typeof value.summaryZh !== 'string') {
    throw new Error('AI translation fields must be strings');
  }
  const titleZh = value.titleZh.trim();
  const summaryZh = value.summaryZh.trim();
  if (!titleZh || !HAN_CHARACTERS.test(titleZh)) {
    throw new Error('AI translation title is empty or lacks Chinese characters');
  }
  if (hasSummary && (!summaryZh || !HAN_CHARACTERS.test(summaryZh))) {
    throw new Error('AI translation summary is empty or lacks Chinese characters');
  }
  if (!hasSummary && summaryZh && !HAN_CHARACTERS.test(summaryZh)) {
    throw new Error('AI translation summary lacks Chinese characters');
  }
  return { titleZh, summaryZh };
}

export async function translateToChinese(
  ai: AiBinding,
  article: TranslationInput,
  configuredModel?: string,
): Promise<ChineseTranslation> {
  const hasSummary = Boolean(article.summary.trim());
  const prompt = `请把下面这篇 Nature 文章信息整理成简体中文。\n\n要求：标题简洁准确，保留作者更正、撤稿等限定信息，不猜测或改写专有名词；${hasSummary
    ? '摘要用 2-3 句概括，忠于原意，不要编造。'
    : '没有英文摘要，只翻译标题；summaryZh 必须是空字符串，不要根据标题编造摘要。'}\n只返回 JSON，格式为 {"titleZh":"...","summaryZh":"..."}。\n\n原标题：${article.title}\n英文摘要：${article.summary || '（无）'}`;
  const result = await ai.run(configuredModel?.trim() || DEFAULT_AI_MODEL, {
    messages: [
      { role: 'system', content: '你是一个科研文章翻译助手，把英文 Nature 文章信息整理成简体中文，只输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 512,
    temperature: 0.3,
  });
  return parseTranslation(responseText(result), hasSummary);
}
