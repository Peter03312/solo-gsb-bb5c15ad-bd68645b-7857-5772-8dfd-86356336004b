'use strict';

// 编辑者按「出处原文」撤回其公开展示：只读预览 + 确认登记。
//
// 数据层只在 source_redactions 追加登记精确出处文本，**不改写任何历史快照
// （versions / version_events / version_relations）或草稿（events / claims /
// relations）**。遮盖在读出层动态生效：
//
//   - 公开访客接口（最新年表、历史版本、专题路线、勘误附记出处）读出时，
//     凡事件主张 source、「先于」关系 source 命中任一已登记文本，
//     一律显示为统一的 REDACTED_SOURCE（「出处已遮盖」），其余字段与版本号不变；
//   - 以后发布含同一文本的新版本，因读出时动态比对，自动遮盖，无需额外处理；
//   - 持编辑口令的接口（草稿状态、恢复预览、版本原文、发布返回）始终返回原文；
//   - 从历史版本恢复草稿复制的是快照原文，草稿区不受遮盖影响。
//
// 命中规则（本轮明确）：**首尾空白等同，其余逐字精确**。
//   手工录入、整理包导入、并行会话保存的出处都可能带首尾空白（录入端保留原文），
//   因此命中比较时先把**库存文本**与**登记文本**各自去除首尾空白再比较：
//     - 「 李宝山口述 」（库存）与「李宝山口述」（登记）⇒ 命中；
//     - 内部空白与其余文字仍须逐字相同：「李宝山 口述」≠「李宝山口述」，部分包含也不命中。
//   该规则统一适用于：预览命中统计（已发布事件主张 / 先于关系 / 草稿提示）、
//   遮盖登记去重，以及全部公开读出层（最新年表、历史版本、专题路线、勘误附记、
//   以后发布的新版本）。比较在 JS 侧用 String#trim 完成，与录入校验的空白口径一致
//   （SQLite 的 TRIM 只去空格，不覆盖换行 / 制表符等，故不在 SQL 里比较）。
//
// 两阶段与恢复草稿 / 导入整包一致：
//   预览（previewSourceRedaction）只读：给出该文本在**全部已发布版本**
//     的事件主张与「先于」关系中命中的位置与数量，以及当前最新版本号；
//   确认（confirmSourceRedaction）须提交预览时的最新版本号 currentVersionNo：
//     - 空 / 纯空白文本 → 400；
//     - 预览后又发布了新版本（最新版本号变化）→ 409 VERSION_CONFLICT，不落库；
//     - 文本已登记过 → 幂等返回已遮盖状态（200，alreadyRedacted: true）。

const { getDb } = require('./db');
const { latestVersionNo } = require('./publish');

const REDACTED_SOURCE = '出处已遮盖';
const MAX_SOURCE_LEN = 1000; // 与出处录入长度上限一致

// 空 / 非字符串 / 超长拒绝；返回 trim 后的文本（精确出处文本）。
function normalizeSourceText(source) {
  if (typeof source !== 'string') {
    throw { status: 400, message: 'source（出处原文）必须是非空字符串' };
  }
  const text = source.trim();
  if (text === '') {
    throw { status: 400, message: '出处原文不能为空：请输入要撤回公开展示的精确出处文本' };
  }
  if (text.length > MAX_SOURCE_LEN) {
    throw { status: 400, message: `出处原文长度不能超过 ${MAX_SOURCE_LEN}` };
  }
  return text;
}

// 首尾空白等同的命中判定：库存出处与查询 / 登记文本各自去除首尾空白后相等即命中；
// 内部空白与其余文字仍须逐字相同（trim 不影响内部字符）。
function sourceTextEquals(storedSource, normalizedText) {
  return typeof storedSource === 'string' && storedSource.trim() === normalizedText;
}

// 公开读出层判定：source 命中任一已登记文本（首尾空白等同）即为被遮盖。
// redactedSet 中的登记文本均已按 trim 规整（见 redactedSourceSet）。
function isRedactedSource(source, redactedSet) {
  return typeof source === 'string' && redactedSet.has(source.trim());
}

function isRedacted(sourceText) {
  return getDb()
    .prepare('SELECT 1 FROM source_redactions WHERE source_text = ?')
    .get(sourceText) !== undefined;
}

// 全部已登记遮盖文本集合（读出层动态遮盖用，数量级为出处条数）。
// 登记时已经 normalizeSourceText 去首尾空白；这里再 trim 一次仅为防御历史 / 手工数据。
function redactedSourceSet() {
  return new Set(
    getDb().prepare('SELECT source_text AS t FROM source_redactions').all().map((r) => r.t.trim())
  );
}

// 公开读出层：把版本详情中命中的 source 统一替换为「出处已遮盖」，其余字段不动。
function applyRedactionToVersion(version, redactedSet = redactedSourceSet()) {
  if (!version || redactedSet.size === 0) return version;
  return {
    ...version,
    events: version.events.map((ev) => ({
      ...ev,
      source: isRedactedSource(ev.source, redactedSet) ? REDACTED_SOURCE : ev.source,
    })),
    relations: version.relations.map((rel) => ({
      ...rel,
      source: isRedactedSource(rel.source, redactedSet) ? REDACTED_SOURCE : rel.source,
    })),
  };
}

// 扫描单个版本快照中的命中位置（首尾空白等同，其余逐字精确），只读。
// 库存出处可能带首尾空白（录入端保留原文），故取出后在 JS 侧按统一规则过滤。
function hitsInVersion(versionNo, sourceText) {
  const db = getDb();
  const versionIdRow = db.prepare('SELECT id FROM versions WHERE version_no = ?').get(versionNo);
  if (!versionIdRow) return null;
  const versionId = versionIdRow.id;

  const eventHits = db
    .prepare(
      `SELECT sort_order AS sortOrder, event_id AS eventId, title, source
         FROM version_events WHERE version_id = ? ORDER BY sort_order`
    )
    .all(versionId)
    .filter((r) => sourceTextEquals(r.source, sourceText))
    .map(({ sortOrder, eventId, title }) => ({ sortOrder, eventId, title }));
  const relationHits = db
    .prepare(
      `SELECT sort_order AS sortOrder, relation_id AS relationId,
              earlier_event_id AS earlierEventId, later_event_id AS laterEventId, source
         FROM version_relations WHERE version_id = ? ORDER BY sort_order`
    )
    .all(versionId)
    .filter((r) => sourceTextEquals(r.source, sourceText))
    .map(({ sortOrder, relationId, earlierEventId, laterEventId }) => ({
      sortOrder,
      relationId,
      earlierEventId,
      laterEventId,
    }));

  return {
    versionNo,
    eventHitCount: eventHits.length,
    relationHitCount: relationHits.length,
    totalHitCount: eventHits.length + relationHits.length,
    eventHits,
    relationHits,
  };
}

// 草稿区（未发布）中的命中：仅供编辑参考——确认后这些内容发布时会自动遮盖。
// 预览主体仍只统计「全部已发布版本」（需求：在已发布版本的事件主张与先于关系中命中）。
// 与已发布版本同一命中规则：首尾空白等同，其余逐字精确。
function draftHits(sourceText) {
  const db = getDb();
  const claimHits = db
    .prepare(
      `SELECT c.id AS claimId, c.event_id AS eventId, e.title, c.source
         FROM claims c JOIN events e ON e.id = c.event_id ORDER BY c.id`
    )
    .all()
    .filter((r) => sourceTextEquals(r.source, sourceText))
    .map(({ claimId, eventId, title }) => ({ claimId, eventId, title }));
  const relationHits = db
    .prepare(
      `SELECT id AS relationId, earlier_id AS earlierEventId, later_id AS laterEventId, source
         FROM relations ORDER BY id`
    )
    .all()
    .filter((r) => sourceTextEquals(r.source, sourceText))
    .map(({ relationId, earlierEventId, laterEventId }) => ({
      relationId,
      earlierEventId,
      laterEventId,
    }));
  return {
    claimHitCount: claimHits.length,
    relationHitCount: relationHits.length,
    totalHitCount: claimHits.length + relationHits.length,
    claimHits,
    relationHits,
  };
}

function buildHitsResult(sourceText, { includeDraft = false } = {}) {
  const db = getDb();
  const versionNos = db
    .prepare('SELECT version_no AS no FROM versions ORDER BY version_no')
    .all()
    .map((r) => r.no);
  const versions = versionNos.map((no) => hitsInVersion(no, sourceText));
  const totalEventHits = versions.reduce((n, v) => n + v.eventHitCount, 0);
  const totalRelationHits = versions.reduce((n, v) => n + v.relationHitCount, 0);
  return {
    source: sourceText,
    currentVersionNo: latestVersionNo(),
    versionCount: versionNos.length,
    totalEventHitCount: totalEventHits,
    totalRelationHitCount: totalRelationHits,
    totalHitCount: totalEventHits + totalRelationHits,
    versions,
    ...(includeDraft ? { draft: draftHits(sourceText) } : {}),
  };
}

// ---------- 只读预览：不写任何数据 ----------
function previewSourceRedaction(source) {
  const sourceText = normalizeSourceText(source);
  return {
    ok: true,
    alreadyRedacted: isRedacted(sourceText),
    ...buildHitsResult(sourceText, { includeDraft: true }),
  };
}

// ---------- 确认：事务内登记遮盖文本（只追加） ----------
// expectedLatestVersionNo: 预览时返回的 currentVersionNo。
// 抛 { status, ...body } 表示 HTTP 错误。
function confirmSourceRedaction({ source, expectedLatestVersionNo, editor = '' }) {
  const sourceText = normalizeSourceText(source);
  const expected = Number(expectedLatestVersionNo);
  if (!Number.isInteger(expected) || expected < 0) {
    throw { status: 400, message: 'currentVersionNo 必须是非负整数（取预览时返回的值）' };
  }

  const db = getDb();
  let alreadyRedacted = false;
  let redactedAt = null;

  const tx = db.transaction(() => {
    const existing = db
      .prepare('SELECT created_at AS createdAt FROM source_redactions WHERE source_text = ?')
      .get(sourceText);
    if (existing) {
      // 重复确认幂等：不做任何写入，直接返回已遮盖状态（优先于版本冲突检查）
      alreadyRedacted = true;
      redactedAt = existing.createdAt;
      return;
    }
    // 事务内重新确认最新版本号：预览后若有人发布了新版本，必须重新预览再确认
    const latest = latestVersionNo();
    if (expected !== latest) {
      throw {
        status: 409,
        code: 'VERSION_CONFLICT',
        message: `版本冲突：你预览遮盖时最新是第 ${expected} 版，现在已是第 ${latest} 版。请重新预览命中范围后再确认。`,
        currentVersionNo: latest,
        expectedVersionNo: expected,
      };
    }
    const info = db
      .prepare('INSERT INTO source_redactions (source_text, editor) VALUES (?, ?)')
      .run(sourceText, String(editor || ''));
    redactedAt = db.prepare('SELECT created_at AS t FROM source_redactions WHERE id = ?').get(info.lastInsertRowid).t;
  });
  tx();

  return {
    ok: true,
    alreadyRedacted,
    redactedAt,
    redactedLabel: REDACTED_SOURCE,
    ...buildHitsResult(sourceText, { includeDraft: false }),
  };
}

// 已登记遮盖清单（编辑者查看，原文仅在持口令接口返回）。
function listRedactions() {
  return getDb()
    .prepare(
      `SELECT id, source_text AS source, editor, created_at AS redactedAt
         FROM source_redactions ORDER BY id DESC`
    )
    .all()
    .map((r) => ({ id: r.id, source: r.source, editor: r.editor, redactedAt: r.redactedAt }));
}

module.exports = {
  REDACTED_SOURCE,
  MAX_SOURCE_LEN,
  previewSourceRedaction,
  confirmSourceRedaction,
  applyRedactionToVersion,
  redactedSourceSet,
  isRedactedSource,
  sourceTextEquals,
  listRedactions,
};
