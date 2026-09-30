const API_BASE = 'https://nature-daily.fanxj137616.workers.dev';

const SOURCE_SPECS = [
  { sourceId: 'nature-main-rss', section: 'Main', mediaName: 'Nature' },
  { sourceId: 'nature-news', section: 'News', mediaName: 'Nature' },
  { sourceId: 'nature-opinion', section: 'Opinion', mediaName: 'Nature' },
  { sourceId: 'nature-research-analysis', section: 'Research Analysis', mediaName: 'Nature' },
  { sourceId: 'nature-research-articles', section: 'Research Articles', mediaName: 'Nature' },
  { sourceId: 'nature-careers', section: 'Careers', mediaName: 'Nature Careers' },
  { sourceId: 'nature-reviews-bioengineering', section: 'Bioengineering', mediaName: 'Nature Reviews Bioengineering' },
];

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
}

function safeArticleUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return '';
  }

  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function formatDate(isoStr) {
  if (!isoStr) return '未知';
  const date = new Date(isoStr);
  if (Number.isNaN(date.getTime())) return isoStr;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'Asia/Shanghai',
  }).format(date);
}

function buildEmptyCard(spec, digestDate) {
  return {
    digestDate: digestDate || '',
    sourceId: spec.sourceId,
    section: spec.section,
    sectionKey: spec.section.toLowerCase().replace(/\s+/g, '-'),
    mediaName: spec.mediaName,
    title: '',
    titleEn: '',
    summary: '',
    summaryEn: '',
    url: '',
    imageUrl: '',
    publishedAt: null,
    selectedAt: '',
    isEmpty: true,
  };
}

function normalizeCard(card, fallbackDate = '') {
  if (!card || typeof card !== 'object') {
    return null;
  }

  const spec = SOURCE_SPECS.find((item) => item.sourceId === card.sourceId);

  return {
    digestDate: card.digestDate || fallbackDate || '',
    sourceId: card.sourceId || '',
    section: card.section || spec?.section || 'Unknown',
    sectionKey: card.sectionKey || (card.section || spec?.section || 'unknown').toLowerCase().replace(/\s+/g, '-'),
    mediaName: card.mediaName || spec?.mediaName || 'Nature',
    title: card.title || '',
    titleEn: card.titleEn || '',
    summary: card.summary || '',
    summaryEn: card.summaryEn || '',
    url: card.url || '',
    imageUrl: card.imageUrl || '',
    publishedAt: card.publishedAt || null,
    selectedAt: card.selectedAt || '',
    isEmpty: Boolean(card.isEmpty),
  };
}

function normalizeDigestPayload(payload) {
  if (payload && Array.isArray(payload.cards)) {
    return {
      digestDate: payload.digestDate || '',
      cards: payload.cards
        .map((card) => normalizeCard(card, payload.digestDate || ''))
        .filter(Boolean),
    };
  }

  if (!payload || typeof payload !== 'object' || !payload.sourceId) {
    return null;
  }

  const digestDate = payload.digestDate || '';
  const rowBySourceId = new Map([
    [
      payload.sourceId,
      normalizeCard(payload, digestDate),
    ],
  ]);

  return {
    digestDate,
    cards: SOURCE_SPECS.map((spec) => rowBySourceId.get(spec.sourceId) || buildEmptyCard(spec, digestDate)),
  };
}

function splitDigestCards(cards, digestDate = '') {
  const lead = cards.find((item) => item.sourceId === 'nature-main-rss')
    || buildEmptyCard(SOURCE_SPECS[0], digestDate);
  const sections = cards.filter((item) => item.sourceId !== 'nature-main-rss');
  return { lead, sections };
}

function renderLeadStory(item) {
  if (item.isEmpty) {
    return `
      <article class="lead-story-shell" data-role="lead-story">
        <div class="story-label-row">
          <span class="story-section">${escapeHtml(item.section)}</span>
          <span class="story-date">${escapeHtml(item.digestDate)}</span>
        </div>
        <div class="story-empty">
          <h2 class="lead-headline">今日主版块暂无可用文章</h2>
          <p class="story-summary">主版块仍保留头条位置，稍后可以直接刷新这一版面。</p>
        </div>
        <div class="story-tools">
          <button class="tool-link refresh-link" data-source-id="${escapeHtml(item.sourceId)}" type="button">换一篇</button>
        </div>
      </article>
    `;
  }

  const articleUrl = safeArticleUrl(item.url);

  return `
    <article class="lead-story-shell" data-role="lead-story">
      <div class="story-label-row">
        <span class="story-section">${escapeHtml(item.section)}</span>
        <span class="story-date">${escapeHtml(item.digestDate)}</span>
      </div>
      <h2 class="lead-headline">${escapeHtml(item.title)}</h2>
      <p class="lead-summary">${escapeHtml(item.summary)}</p>
      <div class="lead-secondary">
        <p class="english-kicker">Original title</p>
        <h3 class="lead-original-title">${escapeHtml(item.titleEn)}</h3>
      </div>
      <div class="story-meta">
        <span>发布时间 ${escapeHtml(formatDate(item.publishedAt))}</span>
        <span>${escapeHtml(item.mediaName)}</span>
      </div>
      <div class="story-tools">
        ${articleUrl
          ? `<a class="article-link article-link-primary" href="${escapeHtml(articleUrl)}" target="_blank" rel="noopener noreferrer">阅读 Nature 原文</a>`
          : '<span class="article-link article-link-muted">暂无原文</span>'}
        <button class="tool-link refresh-link" data-source-id="${escapeHtml(item.sourceId)}" type="button">换一篇</button>
      </div>
    </article>
  `;
}

function renderSectionStory(item) {
  const articleUrl = safeArticleUrl(item.url);
  return `
    <article class="section-story${item.isEmpty ? ' section-story-empty' : ''}" data-role="section-story">
      <div class="story-label-row">
        <span class="story-section">${escapeHtml(item.section)}</span>
        <span class="story-date">${escapeHtml(item.digestDate)}</span>
      </div>
      ${item.isEmpty ? `
        <h3 class="section-headline">今日暂无内容</h3>
        <p class="story-summary">该栏目今天没有抓取到可用文章，保留版位以便刷新。</p>
      ` : `
        <h3 class="section-headline">${escapeHtml(item.title)}</h3>
        <p class="section-summary">${escapeHtml(item.summary)}</p>
        <p class="section-original-title">${escapeHtml(item.titleEn)}</p>
      `}
      <div class="section-tools">
        ${item.isEmpty || !articleUrl
          ? '<span class="article-link article-link-muted">暂无原文</span>'
          : `<a class="article-link" href="${escapeHtml(articleUrl)}" target="_blank" rel="noopener noreferrer">查看原文</a>`}
        <button class="tool-link refresh-link" data-source-id="${escapeHtml(item.sourceId)}" type="button">换一篇</button>
      </div>
    </article>
  `;
}

export function createDigestApp({
  apiBase = API_BASE,
  digestRoot = globalThis.document?.getElementById('digestGrid') || null,
  metaRoot = globalThis.document?.getElementById('metaInfo') || null,
  fetchImpl = globalThis.fetch,
} = {}) {
  let currentDigest = null;

  function renderDigest(payload) {
    const normalized = normalizeDigestPayload(payload);
    currentDigest = normalized;

    if (!digestRoot) {
      return;
    }

    if (!normalized || !Array.isArray(normalized.cards) || normalized.cards.length === 0) {
      digestRoot.innerHTML = '<div class="empty">今日日报暂未生成，请稍后再试。</div>';
      return;
    }

    const { lead, sections } = splitDigestCards(normalized.cards, normalized.digestDate);
    digestRoot.innerHTML = `
      <section class="frontpage-layout">
        ${renderLeadStory(lead)}
        <section class="section-columns" aria-label="Nature daily sections">
          ${sections.map(renderSectionStory).join('')}
        </section>
      </section>
    `;
  }

  function mergeCardUpdate(card) {
    if (!currentDigest || !Array.isArray(currentDigest.cards)) {
      return;
    }

    const normalizedCard = normalizeCard(card, currentDigest.digestDate);
    currentDigest = {
      ...currentDigest,
      cards: currentDigest.cards.map((item) => (item.sourceId === normalizedCard.sourceId ? normalizedCard : item)),
    };
    renderDigest(currentDigest);
  }

  async function refreshCard(sourceId, button) {
    if (button) {
      button.disabled = true;
      button.textContent = '加载中...';
    }

    try {
      const res = await fetchImpl(`${apiBase}/api/daily/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceId }),
      });
      if (!res.ok) throw new Error('refresh error');

      const card = await res.json();
      if (!card || !card.sourceId) {
        await fetchDaily();
        return;
      }

      mergeCardUpdate(card);
    } catch {
      if (button) {
        button.disabled = false;
        button.textContent = '换一篇';
      }
      if (typeof alert === 'function') {
        alert('更换失败，请稍后再试');
      }
    }
  }

  async function fetchMeta() {
    if (!metaRoot) {
      return;
    }

    try {
      const res = await fetchImpl(`${apiBase}/api/meta`);
      if (!res.ok) throw new Error('meta error');
      const data = await res.json();
      const configuredSourceCount = Math.max(SOURCE_SPECS.length, Number(data.sourceCount) || 0);
      metaRoot.textContent = `已配置 ${configuredSourceCount} 个版面 · 已抓取 ${data.articleCount} 篇文章 · 已生成 ${data.digestCount} 期日报`;
    } catch {
      metaRoot.textContent = '无法获取更新状态';
    }
  }

  async function fetchDaily() {
    if (!digestRoot) {
      return;
    }

    try {
      const res = await fetchImpl(`${apiBase}/api/daily`);
      if (!res.ok) throw new Error('daily error');
      const data = await res.json();
      renderDigest(data);
    } catch {
      digestRoot.innerHTML = '<div class="empty">今日日报暂未生成，请稍后再试。</div>';
    }
  }

  return {
    renderDigest,
    mergeCardUpdate,
    fetchMeta,
    fetchDaily,
    refreshCard,
  };
}

if (typeof window !== 'undefined' && window.document) {
  const app = createDigestApp();
  const digestRoot = document.getElementById('digestGrid');

  if (digestRoot) {
    digestRoot.addEventListener('click', (event) => {
      const target = event.target instanceof Element ? event.target.closest('[data-source-id]') : null;
      if (!target) return;

      const sourceId = target.getAttribute('data-source-id');
      if (!sourceId) return;

      app.refreshCard(sourceId, target);
    });
  }

  app.fetchMeta();
  app.fetchDaily();
}
