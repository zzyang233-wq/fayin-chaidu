const DATA_ROOT = 'data/';
const META_URL = 'data/catalog-meta.json';
const SEARCH_INDEX_URL = 'data/search-index.json';
const RECENT_STORAGE_KEY = 'fayin-chaidu:recent-v1';
const RECENT_LIMIT = 12;
const SUGGESTION_LIMIT = 8;
const INDEX_PAGE_SIZE = 80;

const state = {
  catalog: null,
  searchEntries: [],
  exactEntries: new Map(),
  aliasEntries: new Map(),
  shardCache: new Map(),
  wordCache: new Map(),
  currentWord: null,
  pronunciationIndex: 0,
  installPrompt: null,
  shellReady: false,
  offlineReady: false,
  offlineProgress: null,
  activeRuleId: null,
  activeSuggestion: -1,
  indexLimit: INDEX_PAGE_SIZE,
  lookupToken: 0,
};

const TYPE_LABELS = {
  simple: '直接对应', rule: '发音规则', silent: '静音',
  special: '特殊读法', uncertain: '证据不足',
};

const POS_LABELS = {
  ADJ: '形容词', ADV: '副词', ART: '冠词', AUX: '助动词',
  CON: '连词', LIA: '连音', NOM: '名词', ONO: '拟声词',
  PRE: '介词', PRO: '代词', VER: '动词', DET: '限定词',
};

const DIFFICULTY_LABELS = {
  beginner: '入门', beginner_plus: '入门进阶', intermediate: '进阶',
};

const PRIORITY_LABELS = {
  high: '高频基础', medium: '常用', low: '低频提醒',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => (
    {'&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'}[character]
  ));
}

function normalizeExact(value) {
  return String(value ?? '')
    .normalize('NFC')
    .trim()
    .replaceAll('’', "'")
    .toLocaleLowerCase('fr');
}

function lookupKey(value) {
  return normalizeExact(value).replaceAll('œ', 'oe');
}

function foldForFilter(value) {
  return normalizeExact(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function safeUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    return ['http:', 'https:'].includes(url.protocol) ? escapeHtml(url.href) : '#';
  } catch {
    return '#';
  }
}

function statusBadge(status) {
  const normalized = status === 'conflict' ? 'source_conflict' : (status || 'uncertain');
  const labels = {
    ok: '来源可靠', special: '特殊读法', uncertain: '仅显示可靠信息',
    source_conflict: '来源冲突', not_found: '未收录',
  };
  return `<span class="word-status ${escapeHtml(normalized)}">${escapeHtml(labels[normalized] || normalized)}</span>`;
}

function alignmentLabel(method, status = 'complete') {
  if (status !== 'complete' && method === 'lexique_infra') return 'Lexique-Infra 对齐未通过';
  if (status !== 'complete' && method === 'observed_mapping_fallback') return '确定性回退未达到发布门槛';
  return {
    lexique_infra: 'Lexique-Infra 严格匹配',
    lexique_infra_with_resolved_phoneme_correction: 'Infra 分块 + 独立来源音素复核',
    lexique_infra_cross_pos_same_phono: '同词同音跨词性复用',
    manual_override: '有证据的人工对齐',
    observed_mapping_fallback: '确定性回退',
    source_conflict: '来源冲突',
  }[method] || method || '未提供可靠分块';
}

function rulesById() {
  return state.catalog?.rules_by_id || {};
}

function indexPayloadEntries(payload) {
  if (Array.isArray(payload)) return payload;
  return payload.entries || payload.words || payload.search_index || [];
}

function previewIpa(entry) {
  const value = entry.preview_ipa || entry.ipa_preview || entry.ipa;
  if (Array.isArray(value)) return value.filter(Boolean).slice(0, 2).join(' · ');
  return value || '';
}

function buildLookupMaps() {
  state.exactEntries.clear();
  state.aliasEntries.clear();
  state.searchEntries.forEach(entry => {
    const exact = normalizeExact(entry.orthography);
    if (exact && !state.exactEntries.has(exact)) state.exactEntries.set(exact, entry);
    (entry.lookup_aliases || []).forEach(alias => {
      const aliasExact = normalizeExact(alias);
      if (!aliasExact || lookupKey(aliasExact) !== lookupKey(exact)) return;
      if (!state.aliasEntries.has(aliasExact)) state.aliasEntries.set(aliasExact, entry);
    });
  });
}

function findSearchEntry(value) {
  const exact = normalizeExact(value);
  return state.exactEntries.get(exact) || state.aliasEntries.get(exact) || null;
}

function findCatalogWord(value) {
  const entry = findSearchEntry(value);
  return entry ? {orthography: entry.orthography} : null;
}

function manifestChunks() {
  const manifest = state.catalog?.data_manifest || state.catalog?.manifest || {};
  const chunks = manifest.chunks || state.catalog?.chunks || [];
  if (Array.isArray(chunks)) return chunks;
  return Object.entries(chunks).map(([id, item]) => (
    typeof item === 'string' ? {id, url: item} : {id, ...item}
  ));
}

function resolveDataUrl(value) {
  const text = String(value);
  if (/^https?:\/\//i.test(text)) return text;
  if (text.startsWith('data/') || text.startsWith('./data/')) return new URL(text, window.location.href).href;
  return new URL(text, new URL(DATA_ROOT, window.location.href)).href;
}

function resolveChunkUrl(entry) {
  const direct = entry.chunk_url || entry.shard_url;
  if (direct) return resolveDataUrl(direct);
  const chunkId = entry.chunk ?? entry.chunk_id ?? entry.shard;
  const record = manifestChunks().find(item =>
    [item.id, item.chunk, item.chunk_id, item.name, item.hash].some(value => String(value) === String(chunkId))
  );
  const value = record?.url || record?.path || record?.file || chunkId;
  if (!value) throw new Error('该词没有关联的数据分片。');
  const text = String(value);
  const relative = text.includes('/') ? text : `chunks/${text.endsWith('.json') ? text : `${text}.json`}`;
  return resolveDataUrl(relative);
}

async function fetchJson(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}载入失败（HTTP ${response.status}）`);
  return response.json();
}

async function loadShard(entry) {
  const url = resolveChunkUrl(entry);
  if (state.shardCache.has(url)) return state.shardCache.get(url);
  const promise = fetchJson(url, '词条数据').catch(error => {
    state.shardCache.delete(url);
    throw error;
  });
  state.shardCache.set(url, promise);
  return promise;
}

async function loadWord(entry) {
  const key = normalizeExact(entry.orthography);
  if (state.wordCache.has(key)) return state.wordCache.get(key);
  const payload = await loadShard(entry);
  const words = Array.isArray(payload) ? payload : (payload.words || payload.entries || []);
  const word = words.find(item => normalizeExact(item.orthography) === key)
    || words.find(item => item.word_id && entry.word_id && item.word_id === entry.word_id);
  if (!word) throw new Error('索引命中了词形，但对应分片中没有该词条。');
  state.wordCache.set(key, word);
  return word;
}

function renderSegment(segment) {
  const phoneme = segment.phoneme || segment.phoneme_raw || '∅';
  const rule = segment.rule_id && rulesById()[segment.rule_id];
  const content = `
    <span class="grapheme" lang="fr">${escapeHtml(segment.grapheme)}</span>
    <span class="phoneme">${escapeHtml(phoneme)}</span>
    <span class="segment-status">${escapeHtml(TYPE_LABELS[segment.type] || segment.type)}</span>
    ${rule ? '<span class="rule-cue" aria-hidden="true">查看规则 ↗</span>' : ''}`;
  if (rule) {
    return `<button type="button" class="segment ${escapeHtml(segment.type)}" data-rule-id="${escapeHtml(segment.rule_id)}" aria-label="${escapeHtml(segment.grapheme)} 对应 ${escapeHtml(phoneme)}，查看发音规则">${content}</button>`;
  }
  return `<div class="segment ${escapeHtml(segment.type)}" role="listitem">${content}</div>`;
}

function renderAudio(audio, pronunciation) {
  if (audio.review_status !== 'approved' || audio.accent_review !== 'standard_france_approved') return '';
  if (audio.pronunciation_id !== pronunciation.pronunciation_id || audio.heard_ipa !== pronunciation.ipa) return '';
  return `<section class="audio-block" aria-label="真人录音">
    <audio controls preload="none" src="${safeUrl(audio.file_url)}"></audio>
    <p>录音：${escapeHtml(audio.speaker || audio.author)} · ${escapeHtml(audio.license_id)} ·
      <a href="${safeUrl(audio.commons_page)}" target="_blank" rel="noreferrer">Commons 来源页</a></p>
  </section>`;
}

function renderRuleExample(word, options = {}) {
  const catalogWord = findCatalogWord(word);
  const compactClass = options.compact ? ' compact' : '';
  if (catalogWord) {
    return `<button type="button" class="rule-example${compactClass}" data-word="${escapeHtml(catalogWord.orthography)}" lang="fr">${escapeHtml(word)}</button>`;
  }
  return `<span class="rule-example is-static${compactClass}" lang="fr">${escapeHtml(word)}</span>`;
}

function displayRulePattern(rule) {
  return (rule.graphemes || []).join(' / ') || rule.pattern;
}

function renderQuickRules(pronunciation) {
  const ruleIds = [...new Set((pronunciation.segments || [])
    .map(segment => segment.rule_id)
    .filter(ruleId => ruleId && rulesById()[ruleId]))];
  if (!ruleIds.length) return '';
  return `<section class="quick-rules" aria-labelledby="quick-rules-title">
    <div class="section-heading quick-rules-heading">
      <div><p class="eyebrow">快速理解</p><h3 id="quick-rules-title">这个词用到的规则</h3></div>
      <p>先看一句话；需要时再打开详细条件、例外和来源。</p>
    </div>
    <div class="quick-rule-grid">
      ${ruleIds.map(ruleId => {
        const rule = rulesById()[ruleId];
        return `<article class="quick-rule-card">
          <div class="quick-rule-symbol"><span lang="fr">${escapeHtml(displayRulePattern(rule))}</span><strong>${escapeHtml(rule.pronunciation)}</strong></div>
          <h4>${escapeHtml(rule.title)}</h4>
          <p>${escapeHtml(rule.core_rule)}</p>
          <div class="quick-rule-examples" aria-label="典型例词">
            ${(rule.examples || []).slice(0, 3).map(word => renderRuleExample(word, {compact: true})).join('')}
          </div>
          <button type="button" class="rule-detail-link" data-rule-id="${escapeHtml(rule.rule_id)}">查看详细规则 <span aria-hidden="true">→</span></button>
        </article>`;
      }).join('')}
    </div>
  </section>`;
}

function renderTabs(pronunciations) {
  if (pronunciations.length < 2) return '';
  return `<div class="pronunciation-tabs" role="tablist" aria-label="选择词性或读音">
    ${pronunciations.map((pronunciation, index) => {
      const selected = index === state.pronunciationIndex;
      const pos = POS_LABELS[pronunciation.pos] || pronunciation.pos || '未标词性';
      return `<button type="button" role="tab" id="pron-tab-${index}" aria-controls="pronunciation-panel" aria-selected="${selected}" tabindex="${selected ? '0' : '-1'}" data-pron-index="${index}">
        <span>/${escapeHtml(pronunciation.ipa)}/</span><small>${escapeHtml(pos)}</small>
      </button>`;
    }).join('')}
  </div>`;
}

function renderEvidence(word, pronunciation) {
  const records = pronunciation.source?.records || [];
  const sourceRows = records.map(record => `Lexique 4 第 ${record.source_row || '—'} 行 · ${record.lemma || '—'} · ${record.pos || '—'}`);
  const aliasMatches = records.map(record => record.orthography_match).filter(Boolean)
    .map(match => `${match.source_orthography} → ${match.query_orthography}（仅 œ/oe 显式 alias）`);
  const conflict = pronunciation.source_conflict || word.source_conflict;
  const quality = pronunciation.quality || {};
  return `<details class="evidence">
    <summary><span>来源与审核证据</span><small>${escapeHtml(alignmentLabel(pronunciation.alignment?.method, pronunciation.alignment?.status))}</small></summary>
    <div class="evidence-body"><dl>
      <div><dt>整词发音</dt><dd>Lexique 4${pronunciation.phonology_raw ? ` · 原始 Phono <code>${escapeHtml(pronunciation.phonology_raw)}</code>` : ''}</dd></div>
      <div><dt>词内分块</dt><dd>${escapeHtml(alignmentLabel(pronunciation.alignment?.method, pronunciation.alignment?.status))}</dd></div>
      <div><dt>质量分层</dt><dd>整词：${escapeHtml(quality.whole_word_pronunciation?.status || '可靠来源')}<br>对齐：${escapeHtml(quality.grapheme_phoneme_alignment?.status || pronunciation.alignment?.status || '—')}<br>规则：${escapeHtml(quality.teaching_rule_links?.status || '—')}</dd></div>
      <div><dt>来源记录</dt><dd>${sourceRows.map(row => escapeHtml(row)).join('<br>') || '详见 V1 数据清单'}</dd></div>
      ${aliasMatches.length ? `<div><dt>正字法 alias</dt><dd>${aliasMatches.map(row => escapeHtml(row)).join('<br>')}</dd></div>` : ''}
      ${conflict ? `<div><dt>来源冲突</dt><dd>${escapeHtml(conflict.reason || '不同可靠来源记录不一致；应用保留冲突状态。')}</dd></div>` : ''}
    </dl></div>
  </details>`;
}

function isReliableAlignment(pronunciation) {
  return pronunciation.alignment?.status === 'complete'
    && pronunciation.quality?.grapheme_phoneme_alignment?.status !== 'uncertain';
}

function conflictIsResolved(word, pronunciation) {
  if (word.audit?.source_conflict_resolved) return true;
  if (pronunciation.pronunciation_review?.status?.startsWith('resolved')) return true;
  return pronunciation.alignment?.source_conflict_resolution?.status?.startsWith('resolved') || false;
}

function pronunciationNotice(word, pronunciation) {
  const conflict = pronunciation.source_conflict || word.source_conflict || ['conflict', 'source_conflict'].includes(word.status);
  if (conflict) {
    const resolved = conflictIsResolved(word, pronunciation);
    const explanation = resolved
      ? '不同来源的读音记录不一致；当前读音已有独立证据复核，原始差异仍保留在下方审核记录中。'
      : '不同可靠来源的记录尚未得到可审核的统一结论；应用不会选一个值冒充确定答案。';
    return `<div class="data-warning conflict" role="note"><strong>来源记录存在冲突${resolved ? '，已按证据复核' : ''}。</strong><span>${explanation}</span></div>`;
  }
  if (isReliableAlignment(pronunciation)) return '';
  return `<div class="data-warning" role="note"><strong>全词发音有可靠来源，但暂不解释拼写分块。</strong><span>当前 grapheme–phoneme 对齐没有达到发布门槛，因此这里只显示 IPA，不猜分块或规则。</span></div>`;
}

function renderWord(word) {
  if (word.status === 'not_found') return renderMissingQuery(word.orthography);
  const pronunciations = (word.pronunciations || []).filter(item => item.ipa);
  if (!pronunciations.length) {
    return `<article class="empty-card">${statusBadge(word.status || 'uncertain')}<h2>没有可发布的来源发音</h2><p>系统不会从拼写预测 IPA。来源状态已保留，等待后续审核。</p></article>`;
  }
  state.pronunciationIndex = Math.min(state.pronunciationIndex, pronunciations.length - 1);
  const pronunciation = pronunciations[state.pronunciationIndex];
  const hasConflict = Boolean(pronunciation.source_conflict || word.source_conflict || ['conflict', 'source_conflict'].includes(word.status));
  if (hasConflict && !conflictIsResolved(word, pronunciation)) {
    return `<article class="empty-card">${statusBadge('source_conflict')}<p class="empty-word" lang="fr">${escapeHtml(word.orthography)}</p>
      <h2>来源冲突，当前不发布读音</h2><p>可靠来源之间尚未得到可审核的统一结论。原始记录仍保留，但应用不会把其中一个值当作确定答案。</p></article>`;
  }
  const pos = POS_LABELS[pronunciation.pos] || pronunciation.pos || '未标词性';
  const alignmentReliable = isReliableAlignment(pronunciation);
  const audio = (pronunciation.audio || word.audio || []).map(item => renderAudio(item, pronunciation)).join('');
  const panelAttributes = pronunciations.length > 1
    ? `id="pronunciation-panel" role="tabpanel" aria-labelledby="pron-tab-${state.pronunciationIndex}"`
    : '';
  const hasSpecialSegment = (pronunciation.segments || []).some(segment => segment.type === 'special');
  const displayedStatus = pronunciation.source_conflict
    ? 'source_conflict'
    : (hasSpecialSegment ? 'special' : (word.status || (alignmentReliable ? 'ok' : 'uncertain')));

  return `<article class="word-card">
    <header class="word-heading">
      <div><div class="word-meta">${statusBadge(displayedStatus)}<span>${escapeHtml(pos)}${pronunciation.pos ? ` · ${escapeHtml(pronunciation.pos)}` : ''}</span></div>
        <h2 lang="fr">${escapeHtml(word.orthography)}</h2>
        <p class="ipa" aria-label="国际音标 ${escapeHtml(pronunciation.ipa)}">/${escapeHtml(pronunciation.ipa)}/</p>
      </div>
      <button type="button" class="copy-link" data-copy-link>复制查询链接</button>
    </header>
    ${renderTabs(pronunciations)}
    <div ${panelAttributes}>
      ${pronunciationNotice(word, pronunciation)}
      ${alignmentReliable ? `<section class="alignment-section" aria-labelledby="alignment-title">
        <div class="section-heading"><div><p class="eyebrow">拼写与声音</p><h3 id="alignment-title">逐块对齐</h3></div><p>上排是拼写，下排是对应音。蓝色块可打开规则。</p></div>
        <div class="segments" role="list">${(pronunciation.segments || []).map(renderSegment).join('')}</div>
      </section>${renderQuickRules(pronunciation)}` : ''}
      ${audio}
      ${renderEvidence(word, pronunciation)}
    </div>
  </article>`;
}

function renderMissingQuery(value) {
  return `<article class="empty-card">
    ${statusBadge('not_found')}
    <p class="empty-word" lang="fr">${escapeHtml(value || '—')}</p>
    <h2>正式词库中没有这个词形</h2>
    <p>系统没有猜 IPA，也不会删除重音或用模糊拼写制造命中。请检查拼写，或浏览当前收录词形。</p>
    <button type="button" class="primary-inline" data-open-index>浏览词库</button>
  </article>`;
}

function renderLoadError(value, error) {
  const offline = !navigator.onLine;
  return `<article class="empty-card">${statusBadge('uncertain')}<p class="empty-word" lang="fr">${escapeHtml(value)}</p>
    <h2>${offline ? '这个词的数据尚未离线保存' : '暂时无法载入词条'}</h2>
    <p>${offline ? '恢复网络后打开一次，或等待顶部显示“完整词库可离线使用”。' : escapeHtml(error.message)}</p>
    <button type="button" class="primary-inline" data-retry-word="${escapeHtml(value)}">重试</button></article>`;
}

function setResult(html) {
  const result = document.querySelector('#result');
  result.setAttribute('aria-busy', 'false');
  result.innerHTML = html;
  result.querySelector('.word-card, .empty-card')?.classList.add('result-enter');
}

function setLoading(word) {
  const result = document.querySelector('#result');
  result.setAttribute('aria-busy', 'true');
  result.innerHTML = `<div class="loading-state"><span class="loading-mark" aria-hidden="true"></span><p>正在载入 <span lang="fr">${escapeHtml(word)}</span>…</p></div>`;
}

async function lookup(value, options = {}) {
  if (!state.catalog) return;
  hideSuggestions();
  const query = String(value ?? '').trim();
  const token = ++state.lookupToken;
  const entry = findSearchEntry(query);
  if (!options.keepPronunciation) state.pronunciationIndex = 0;
  if (!entry) {
    state.currentWord = null;
    setResult(renderMissingQuery(query));
    document.title = '未收录 · 法音拆读';
    const url = new URL(window.location.href);
    if (query) url.searchParams.set('word', query);
    else url.searchParams.delete('word');
    if (options.updateHistory !== false && url.href !== window.location.href) history.pushState({word: query}, '', url);
    return;
  }

  setLoading(entry.orthography);
  try {
    const word = await loadWord(entry);
    if (token !== state.lookupToken) return;
    state.currentWord = word;
    setResult(renderWord(word));
    document.querySelector('#word-input').value = word.orthography;
    document.title = `${word.orthography} · 法音拆读`;
    if (options.addRecent !== false) addRecent(word.orthography);
    const url = new URL(window.location.href);
    url.searchParams.set('word', word.orthography);
    if (options.updateHistory !== false && url.href !== window.location.href) history.pushState({word: word.orthography}, '', url);
  } catch (error) {
    if (token !== state.lookupToken) return;
    state.currentWord = null;
    setResult(renderLoadError(entry.orthography, error));
  }
}

function renderRuleListSection(title, items, className = '') {
  if (!items?.length) return '';
  return `<section class="rule-detail-section ${escapeHtml(className)}"><h3>${escapeHtml(title)}</h3><ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul></section>`;
}

function renderRuleSources(sourceRefs) {
  if (!sourceRefs?.length) return '';
  return `<details class="rule-sources"><summary>来源与审核记录 <span>${sourceRefs.length}</span></summary><div class="rule-source-list">
    ${sourceRefs.map(source => `<article><h4><a href="${safeUrl(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.source_name)}</a></h4><p>${escapeHtml(source.section)}</p><small>核对日期 ${escapeHtml(source.checked_date)} · ${escapeHtml(source.note)}</small></article>`).join('')}
  </div></details>`;
}

function openRule(ruleId) {
  const rule = rulesById()[ruleId];
  if (!rule) return;
  state.activeRuleId = ruleId;
  const currentWord = state.currentWord?.orthography || '当前单词';
  document.querySelector('#rule-return-word').textContent = currentWord;
  document.querySelector('#rule-dialog-context').textContent = `查询仍停留在 ${currentWord}`;
  document.querySelector('#rule-dialog-content').innerHTML = `
    <header class="rule-detail-heading"><div class="rule-detail-symbol" aria-hidden="true"><span lang="fr">${escapeHtml(displayRulePattern(rule))}</span><i>→</i><strong>${escapeHtml(rule.pronunciation)}</strong></div>
      <h2 id="rule-dialog-title" tabindex="-1">${escapeHtml(rule.title)}</h2>
      <p class="rule-id">${escapeHtml(rule.rule_id)} · ${escapeHtml(DIFFICULTY_LABELS[rule.difficulty] || rule.difficulty)} · ${escapeHtml(PRIORITY_LABELS[rule.pedagogical_priority] || rule.pedagogical_priority)}</p></header>
    <p class="rule-core">${escapeHtml(rule.core_rule)}</p>
    <section class="rule-detail-section rule-learner-explanation"><h3>怎么理解</h3>${(rule.learner_explanation || []).map(paragraph => `<p>${escapeHtml(paragraph)}</p>`).join('')}</section>
    ${renderRuleListSection('使用条件', rule.condition_explanations, 'rule-conditions')}
    ${renderRuleListSection('什么时候不用这条规则', rule.non_applications, 'rule-non-applications')}
    ${renderRuleListSection('需要单独记的例外', rule.exceptions, 'rule-exceptions')}
    <section class="rule-detail-section"><h3>例词</h3><div class="example-list">${(rule.examples || []).map(word => renderRuleExample(word)).join('')}</div><p class="example-hint">已收录的蓝色例词可以直接跳转。</p></section>
    ${(rule.related_rules || []).length ? `<section class="rule-detail-section"><h3>相关规则</h3><div class="related-rule-list">${rule.related_rules.map(relatedId => {
      const related = rulesById()[relatedId];
      return related ? `<button type="button" data-rule-id="${escapeHtml(relatedId)}"><span>${escapeHtml(related.title)}</span><small>${escapeHtml(related.core_rule)}</small></button>` : '';
    }).join('')}</div></section>` : ''}
    ${renderRuleSources(rule.source_refs)}
    <button type="button" class="rule-bottom-back" data-close-dialog>返回 ${escapeHtml(currentWord)}</button>`;
  const dialog = document.querySelector('#rule-dialog');
  if (!dialog.open) dialog.showModal();
  window.setTimeout(() => document.querySelector('#rule-dialog-title')?.focus({preventScroll: true}), 0);
}

function rankedEntries(filter, limit = SUGGESTION_LIMIT) {
  const exact = normalizeExact(filter);
  const folded = foldForFilter(filter);
  if (!exact) return [];
  return state.searchEntries
    .map(entry => {
      const orth = normalizeExact(entry.orthography);
      const foldedOrth = foldForFilter(entry.orthography);
      let rank = 5;
      if (orth === exact) rank = 0;
      else if (orth.startsWith(exact)) rank = 1;
      else if ((entry.lookup_aliases || []).some(alias => normalizeExact(alias).startsWith(exact))) rank = 2;
      else if (foldedOrth.startsWith(folded)) rank = 3;
      else if (foldedOrth.includes(folded)) rank = 4;
      return {entry, rank};
    })
    .filter(item => item.rank < 5)
    .sort((a, b) => a.rank - b.rank || a.entry.orthography.length - b.entry.orthography.length || a.entry.orthography.localeCompare(b.entry.orthography, 'fr'))
    .slice(0, limit)
    .map(item => item.entry);
}

function hideSuggestions() {
  const box = document.querySelector('#search-suggestions');
  box.hidden = true;
  box.innerHTML = '';
  state.activeSuggestion = -1;
  const input = document.querySelector('#word-input');
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
}

function renderSuggestions(value) {
  const suggestions = rankedEntries(value);
  const box = document.querySelector('#search-suggestions');
  state.activeSuggestion = -1;
  if (!suggestions.length) {
    hideSuggestions();
    return;
  }
  box.innerHTML = suggestions.map((entry, index) => `<button type="button" id="search-option-${index}" role="option" aria-selected="false" data-suggestion-word="${escapeHtml(entry.orthography)}">
    <span lang="fr">${escapeHtml(entry.orthography)}</span><small>${previewIpa(entry) ? `/${escapeHtml(previewIpa(entry))}/` : '来源发音'}</small>
  </button>`).join('');
  box.hidden = false;
  document.querySelector('#word-input').setAttribute('aria-expanded', 'true');
}

function moveSuggestion(delta) {
  const options = [...document.querySelectorAll('#search-suggestions [role="option"]')];
  if (!options.length) return;
  state.activeSuggestion = (state.activeSuggestion + delta + options.length) % options.length;
  options.forEach((option, index) => option.setAttribute('aria-selected', String(index === state.activeSuggestion)));
  const active = options[state.activeSuggestion];
  document.querySelector('#word-input').setAttribute('aria-activedescendant', active.id);
  active.scrollIntoView({block: 'nearest'});
}

function readRecent() {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_STORAGE_KEY) || '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'string').slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

function writeRecent(words) {
  try { localStorage.setItem(RECENT_STORAGE_KEY, JSON.stringify(words.slice(0, RECENT_LIMIT))); } catch {}
  renderRecent();
}

function addRecent(word) {
  const key = normalizeExact(word);
  const words = [word, ...readRecent().filter(item => normalizeExact(item) !== key)].slice(0, RECENT_LIMIT);
  writeRecent(words);
}

function renderRecent() {
  const words = readRecent().filter(word => findSearchEntry(word));
  const section = document.querySelector('#recent-queries');
  section.hidden = !words.length;
  document.querySelector('#recent-list').innerHTML = words.map(word => `<button type="button" data-word="${escapeHtml(word)}" lang="fr">${escapeHtml(word)}</button>`).join('');
}

function filteredIndexEntries(filter = '') {
  const query = foldForFilter(filter);
  if (!query) return state.searchEntries;
  return state.searchEntries.filter(entry => foldForFilter(entry.orthography).includes(query));
}

function renderWordIndex(filter = '') {
  const words = filteredIndexEntries(filter);
  const visible = words.slice(0, state.indexLimit);
  document.querySelector('#index-count').textContent = `显示 ${visible.length.toLocaleString('zh-CN')} / ${words.length.toLocaleString('zh-CN')} 个词形`;
  document.querySelector('#word-index-list').innerHTML = visible.length
    ? visible.map(entry => `<button type="button" data-word="${escapeHtml(entry.orthography)}"><span lang="fr">${escapeHtml(entry.orthography)}</span><small>${previewIpa(entry) ? `/${escapeHtml(previewIpa(entry))}/` : ''}</small></button>`).join('')
    : '<p class="index-empty">没有匹配的词形。</p>';
  const more = document.querySelector('#index-more');
  more.hidden = visible.length >= words.length;
  more.textContent = `再显示 ${Math.min(INDEX_PAGE_SIZE, words.length - visible.length)} 个`;
}

function openIndex() {
  state.indexLimit = INDEX_PAGE_SIZE;
  renderWordIndex(document.querySelector('#index-search').value);
  const dialog = document.querySelector('#word-index-dialog');
  if (!dialog.open) dialog.showModal();
  window.setTimeout(() => document.querySelector('#index-search').focus(), 0);
}

async function selectWord(value) {
  document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
  await lookup(value);
  document.querySelector('#result').scrollIntoView({behavior: 'smooth', block: 'start'});
}

function summaryValue(...keys) {
  const summary = state.catalog?.summary || {};
  for (const key of keys) if (summary[key] !== undefined && summary[key] !== null) return summary[key];
  return null;
}

function summaryMetric(name) {
  const value = state.catalog?.summary?.metrics?.[name];
  if (value === undefined || value === null) return null;
  return typeof value === 'object' ? value.percentage : value;
}

function formatCoverage(value) {
  if (value === null) return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value);
  if (number <= 1) return `${(number * 100).toFixed(1)}%`;
  return number.toLocaleString('zh-CN');
}

function updateAuditStrip() {
  document.querySelector('#stat-pronunciation').textContent = formatCoverage(summaryValue('word_count', 'words', 'total_words') ?? state.searchEntries.length);
  const alignment = summaryMetric('reliable_segmentation_word') ?? summaryValue('reliable_segmentation_rate', 'automatic_reliable_final_alignment_rate', 'alignment_coverage');
  const ruleLinks = summaryMetric('rule_link_word') ?? summaryValue('rule_link_coverage', 'rule_link_rate');
  document.querySelector('#stat-alignment').textContent = alignment === null ? '—' : `${Number(alignment).toFixed(1)}%`;
  document.querySelector('#stat-manual').textContent = ruleLinks === null ? '—' : `${Number(ruleLinks).toFixed(1)}%`;
  const approved = summaryValue('approved_audio_count', 'audio_approved');
  document.querySelector('#stat-audio').textContent = approved ? Number(approved).toLocaleString('zh-CN') : '审核制';
}

function updateConnectionStatus() {
  const element = document.querySelector('#offline-status');
  const offline = !navigator.onLine;
  if (offline) element.textContent = state.offlineReady ? '完整词库离线可用' : (state.shellReady ? '离线 · 已缓存词可用' : '网络不可用');
  else if (state.offlineReady) element.textContent = '完整词库可离线使用';
  else if (state.offlineProgress) element.textContent = `准备离线词库 ${state.offlineProgress.done}/${state.offlineProgress.total}`;
  else element.textContent = state.shellReady ? '应用已就绪' : '在线';
  element.classList.toggle('is-offline', offline);
  element.classList.toggle('is-preparing', Boolean(state.offlineProgress && !state.offlineReady));
}

document.querySelector('#lookup-form').addEventListener('submit', event => {
  event.preventDefault();
  lookup(document.querySelector('#word-input').value);
});

document.querySelector('#word-input').addEventListener('input', event => renderSuggestions(event.target.value));
document.querySelector('#word-input').addEventListener('focus', event => {
  if (event.target.value.trim()) renderSuggestions(event.target.value);
});
document.querySelector('#word-input').addEventListener('keydown', event => {
  const options = [...document.querySelectorAll('#search-suggestions [role="option"]')];
  if (event.key === 'ArrowDown') { event.preventDefault(); moveSuggestion(1); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); moveSuggestion(-1); }
  else if (event.key === 'Escape') hideSuggestions();
  else if (event.key === 'Enter' && state.activeSuggestion >= 0 && options[state.activeSuggestion]) {
    event.preventDefault();
    selectWord(options[state.activeSuggestion].dataset.suggestionWord);
  }
});

document.addEventListener('click', event => {
  const suggestion = event.target.closest('[data-suggestion-word]');
  if (suggestion) selectWord(suggestion.dataset.suggestionWord);

  const ruleButton = event.target.closest('[data-rule-id]');
  if (ruleButton) openRule(ruleButton.dataset.ruleId);

  const wordButton = event.target.closest('[data-word]');
  if (wordButton) selectWord(wordButton.dataset.word);

  if (event.target.closest('[data-open-index]') || event.target.closest('#open-index')) openIndex();

  const retry = event.target.closest('[data-retry-word]');
  if (retry) lookup(retry.dataset.retryWord);

  const tab = event.target.closest('[data-pron-index]');
  if (tab && state.currentWord) {
    state.pronunciationIndex = Number(tab.dataset.pronIndex);
    setResult(renderWord(state.currentWord));
  }

  const closeButton = event.target.closest('[data-close-dialog]');
  if (closeButton) closeButton.closest('dialog').close();

  if (!event.target.closest('.combobox-shell')) hideSuggestions();

  if (event.target.closest('[data-copy-link]')) {
    navigator.clipboard?.writeText(window.location.href).then(() => {
      const button = document.querySelector('[data-copy-link]');
      if (!button) return;
      button.textContent = '链接已复制';
      window.setTimeout(() => { if (button) button.textContent = '复制查询链接'; }, 1600);
    }).catch(() => {});
  }
});

document.querySelector('#clear-recent').addEventListener('click', () => writeRecent([]));
document.querySelector('#index-search').addEventListener('input', event => {
  state.indexLimit = INDEX_PAGE_SIZE;
  renderWordIndex(event.target.value);
});
document.querySelector('#index-more').addEventListener('click', () => {
  state.indexLimit += INDEX_PAGE_SIZE;
  renderWordIndex(document.querySelector('#index-search').value);
});

document.querySelector('#result').addEventListener('keydown', event => {
  const tab = event.target.closest('[role="tab"]');
  if (!tab || !state.currentWord) return;
  const tabs = [...document.querySelectorAll('.pronunciation-tabs [role="tab"]')];
  const current = tabs.indexOf(tab);
  let next = current;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  else if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = tabs.length - 1;
  else return;
  event.preventDefault();
  state.pronunciationIndex = next;
  setResult(renderWord(state.currentWord));
  document.querySelector(`[data-pron-index="${next}"]`)?.focus();
});

document.querySelectorAll('dialog').forEach(dialog => {
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => { if (dialog.id === 'rule-dialog') state.activeRuleId = null; });
});

document.addEventListener('keydown', event => {
  if (event.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) {
    event.preventDefault();
    document.querySelector('#word-input').focus();
  }
});

window.addEventListener('popstate', () => {
  const value = new URL(window.location.href).searchParams.get('word') || 'beaucoup';
  lookup(value, {updateHistory: false, addRecent: false});
});
window.addEventListener('online', updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);
updateConnectionStatus();

Promise.all([
  fetchJson(META_URL, '词库说明'),
  fetchJson(SEARCH_INDEX_URL, '搜索索引'),
]).then(([catalog, searchIndex]) => {
  state.catalog = catalog;
  state.searchEntries = indexPayloadEntries(searchIndex);
  buildLookupMaps();
  updateAuditStrip();
  renderRecent();
  renderWordIndex();
  const requested = new URL(window.location.href).searchParams.get('word');
  lookup(requested || 'beaucoup', {updateHistory: false, addRecent: false});
}).catch(error => {
  setResult(`<article class="empty-card"><h2>无法载入词库索引</h2><p>${escapeHtml(error.message)}</p><p>请通过本地服务器打开；如果当前离线，请先在联网时完成一次加载。</p></article>`);
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', event => {
    const message = event.data || {};
    if (message.type === 'OFFLINE_PROGRESS') {
      state.offlineProgress = {done: Number(message.done || 0), total: Number(message.total || 0)};
    } else if (message.type === 'OFFLINE_READY') {
      state.offlineProgress = null;
      state.offlineReady = true;
    } else if (message.type === 'OFFLINE_ERROR') {
      state.offlineProgress = null;
    } else if (message.type === 'SHELL_READY') {
      state.shellReady = true;
    }
    updateConnectionStatus();
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js')
      .then(() => navigator.serviceWorker.ready)
      .then(registration => {
        state.shellReady = true;
        updateConnectionStatus();
        (registration.active || navigator.serviceWorker.controller)?.postMessage({type: 'PREPARE_OFFLINE'});
      })
      .catch(() => updateConnectionStatus());
  });
} else {
  document.querySelector('#offline-status').textContent = '浏览器不支持离线安装';
}
