'use strict';

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert');
process.env.EDITOR_TOKEN = 'test-token';
const Database = require('better-sqlite3');

const mem = new Database(':memory:');
const { SCHEMA, setDb } = require('../src/db');
mem.exec(SCHEMA);
setDb(mem);

const { app } = require('../src/server');
const { REDACTED_SOURCE } = require('../src/redact');

const TOKEN = 'test-token';
let base;
let server;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  mem.close();
});

beforeEach(() => {
  mem.exec(`
    DELETE FROM source_redactions;
    DELETE FROM errata;
    DELETE FROM route_segments;
    DELETE FROM route_anchors;
    DELETE FROM routes;
    DELETE FROM import_batches;
    DELETE FROM version_relations;
    DELETE FROM version_events;
    DELETE FROM versions;
    DELETE FROM relations;
    DELETE FROM claims;
    DELETE FROM events;
    DELETE FROM sqlite_sequence;
    UPDATE draft_meta SET revision = 0;
  `);
});

async function call(method, url, { token = TOKEN, body } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'X-Editor-Token': token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function makeEvent(title) {
  const r = await call('POST', '/api/editor/events', { body: { title } });
  assert.strictEqual(r.status, 201);
  return r.json.event.id;
}

async function makeClaim(eventId, payload) {
  const r = await call('POST', `/api/editor/events/${eventId}/claims`, { body: payload });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.claim.id;
}

async function makeRel(earlierId, laterId, source = '') {
  const r = await call('POST', '/api/editor/relations', { body: { earlierId, laterId, source } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json.relation.id;
}

async function publish(selection, baseVersionNo) {
  const r = await call('POST', '/api/editor/publish', { body: { selection, baseVersionNo } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.json));
  return r.json;
}

const SRC = '李宝山口述，2021-07-05 访谈';
const SRC2 = '《县水利志》1994 年版，第 87 页';

// 发两版：v1 两个事件 + 一条带 SRC 的先于关系；v2 再加一个事件
async function setupTwoVersions() {
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: SRC });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: SRC2 });
  await makeRel(e1, e2, SRC);
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  const e3 = await makeEvent('抽水机到站');
  const c3 = await makeClaim(e3, { precision: 'year', year: 1962, source: SRC }); // 同一出处
  await publish(
    [{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }, { eventId: e3, claimId: c3 }],
    1
  );
  return { e1, e2, e3, c1, c2, c3 };
}

test('遮盖接口需要编辑口令；公开接口无需口令', async () => {
  const r1 = await call('POST', '/api/editor/redaction-preview', { token: null, body: { source: 'x' } });
  assert.strictEqual(r1.status, 401);
  const r2 = await call('POST', '/api/editor/redaction', { token: null, body: { source: 'x', currentVersionNo: 0 } });
  assert.strictEqual(r2.status, 401);
});

test('预览：列全全部已发布版本中事件主张与先于关系的命中位置与数量，只读不落库', async () => {
  await setupTwoVersions();
  const r = await call('POST', '/api/editor/redaction-preview', { body: { source: `  ${SRC}  ` } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  const p = r.json;
  assert.strictEqual(p.source, SRC); // 返回 trim 后的精确文本
  assert.strictEqual(p.alreadyRedacted, false);
  assert.strictEqual(p.currentVersionNo, 2);
  assert.strictEqual(p.versionCount, 2);
  assert.strictEqual(p.totalEventHitCount, 3); // v1 动员会 1 + v2 动员会、抽水机 2
  assert.strictEqual(p.totalRelationHitCount, 2); // 关系复制进每个版本快照：v1、v2 各 1
  assert.strictEqual(p.totalHitCount, 5);

  const v1 = p.versions.find((v) => v.versionNo === 1);
  assert.strictEqual(v1.eventHitCount, 1);
  assert.strictEqual(v1.eventHits[0].title, '动员会');
  assert.strictEqual(v1.relationHitCount, 1);
  assert.deepStrictEqual(Object.keys(v1.relationHits[0]).sort(),
    ['earlierEventId', 'laterEventId', 'relationId', 'sortOrder'].sort());
  const v2 = p.versions.find((v) => v.versionNo === 2);
  assert.strictEqual(v2.eventHitCount, 2); // 动员会（沿自 v1）与抽水机
  assert.strictEqual(v2.relationHitCount, 1); // 关系在 v2 快照中同样存在
  assert.strictEqual(v2.eventHits.some((h) => h.title === '抽水机到站'), true);

  // 预览只读：尚未遮盖
  const pub = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(pub.json.version.events.find((e) => e.title === '抽水机到站').source, SRC);
  assert.strictEqual(pub.json.version.relations[0].source, SRC);

  // 未命中文本合计为 0
  const none = await call('POST', '/api/editor/redaction-preview', { body: { source: '不存在的出处' } });
  assert.strictEqual(none.json.totalHitCount, 0);
});

test('空 / 纯空白 / 非字符串文本拒绝（400）', async () => {
  for (const source of ['', '   ', '\t\n']) {
    const r = await call('POST', '/api/editor/redaction-preview', { body: { source } });
    assert.strictEqual(r.status, 400, JSON.stringify(source));
  }
  const r1 = await call('POST', '/api/editor/redaction-preview', { body: { source: 123 } });
  assert.strictEqual(r1.status, 400);
  const missing = await call('POST', '/api/editor/redaction-preview', { body: {} });
  assert.strictEqual(missing.status, 400);
});

test('空文本确认同样 400；currentVersionNo 非法 400', async () => {
  const r1 = await call('POST', '/api/editor/redaction', { body: { source: '   ', currentVersionNo: 0 } });
  assert.strictEqual(r1.status, 400);
  const r2 = await call('POST', '/api/editor/redaction', { body: { source: 123, currentVersionNo: 0 } });
  assert.strictEqual(r2.status, 400);
  const r3 = await call('POST', '/api/editor/redaction', { body: { source: 'x' } });
  assert.strictEqual(r3.status, 400);
});

test('确认后访客读最新年表与历史版本：命中处显示「出处已遮盖」，其余字段与版本号不变', async () => {
  const ids = await setupTwoVersions();
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  const confirm = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: preview.json.currentVersionNo, editor: '志愿者小王' },
  });
  assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.json));
  assert.strictEqual(confirm.json.alreadyRedacted, false);
  assert.strictEqual(confirm.json.redactedLabel, REDACTED_SOURCE);
  assert.strictEqual(confirm.json.totalHitCount, 5);

  // 最新年表（v2）
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.currentVersionNo, 2);
  const v2 = latest.json.version;
  for (const ev of v2.events) {
    if (ev.title === '动员会' || ev.title === '抽水机到站') {
      assert.strictEqual(ev.source, REDACTED_SOURCE);
    } else {
      assert.strictEqual(ev.source, SRC2); // 未命中不变
    }
    // 其余字段不变
    assert.ok(ev.dateLabel && ev.resolvedDate && ev.intervalStart);
  }
  assert.strictEqual(v2.relations[0].source, REDACTED_SOURCE);

  // 指定历史版本 v1
  const old = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(old.status, 200);
  assert.strictEqual(old.json.version.versionNo, 1);
  assert.strictEqual(old.json.version.events[0].source, REDACTED_SOURCE);
  assert.strictEqual(old.json.version.relations[0].source, REDACTED_SOURCE);

  // 快照行在库里未被改写（原文仍在）
  const rawRow = mem.prepare('SELECT source FROM version_events WHERE event_id = ? ORDER BY sort_order').get(ids.e1);
  assert.strictEqual(rawRow.source, SRC);
});

test('持编辑口令查看版本原文仍是原文；草稿状态与恢复预览/恢复草稿均用原文', async () => {
  await setupTwoVersions();
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });

  const raw = await call('GET', '/api/editor/versions/1/raw');
  assert.strictEqual(raw.status, 200);
  assert.strictEqual(raw.json.version.events[0].source, SRC);
  assert.strictEqual(raw.json.version.relations[0].source, SRC);

  // 草稿状态：原文
  const state = await call('GET', '/api/editor/state');
  assert.ok(state.json.events.some((e) => e.claims.some((c) => c.source === SRC)));
  assert.ok(state.json.relations.some((r) => r.source === SRC));

  // 恢复预览：版本部分为原文
  const rp = await call('GET', '/api/editor/restore-preview/1');
  assert.strictEqual(rp.json.version.events[0].source, SRC);
  assert.strictEqual(rp.json.version.relations[0].source, SRC);

  // 确认恢复：重建的草稿仍是原文
  const restored = await call('POST', '/api/editor/restore', {
    body: {
      versionNo: 1,
      draftRevisionNo: rp.json.draftRevisionNo,
      currentVersionNo: rp.json.currentVersionNo,
    },
  });
  assert.strictEqual(restored.status, 200, JSON.stringify(restored.json));
  const state2 = await call('GET', '/api/editor/state');
  assert.ok(state2.json.events.every((e) => e.claims.length === 1));
  assert.strictEqual(state2.json.events[0].claims[0].source, SRC);
  assert.strictEqual(state2.json.relations[0].source, SRC);
});

test('以后发布含同一文本的新版本自动遮盖；快照本身仍存原文', async () => {
  const ids = await setupTwoVersions();
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });

  // 草稿里再补一个带 SRC 的主张并发布 v3
  const e4 = await makeEvent('新发现事件');
  const c4 = await makeClaim(e4, { precision: 'year', year: 1963, source: SRC });
  const pub = await publish(
    [
      { eventId: ids.e1, claimId: ids.c1 },
      { eventId: ids.e2, claimId: ids.c2 },
      { eventId: ids.e3, claimId: ids.c3 },
      { eventId: e4, claimId: c4 },
    ],
    2
  );
  assert.strictEqual(pub.versionNo, 3);

  // 发布返回（编辑者视角）是原文
  assert.strictEqual(pub.version.events.find((e) => e.title === '新发现事件').source, SRC);
  // 访客视图自动遮盖
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.currentVersionNo, 3);
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '新发现事件').source, REDACTED_SOURCE);

  // 快照库存原文
  const row = mem.prepare('SELECT source FROM version_events WHERE event_id = ?').get(e4);
  assert.strictEqual(row.source, SRC);
});

test('预览后发布了新版本，确认报 409 VERSION_CONFLICT 且不落库', async () => {
  const ids = await setupTwoVersions(); // 最新 = 2
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.currentVersionNo, 2);

  // 期间发布 v3（把现有选择重发一版）
  await publish(
    [{ eventId: ids.e1, claimId: ids.c1 }, { eventId: ids.e2, claimId: ids.c2 }, { eventId: ids.e3, claimId: ids.c3 }],
    2
  );

  const stale = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 2 },
  });
  assert.strictEqual(stale.status, 409);
  assert.strictEqual(stale.json.code, 'VERSION_CONFLICT');
  assert.strictEqual(stale.json.currentVersionNo, 3);

  // 未登记：访客仍见原文
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '动员会').source, SRC);

  // 重新预览后确认成功
  const preview2 = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  const ok = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: preview2.json.currentVersionNo },
  });
  assert.strictEqual(ok.status, 200);
  const latest2 = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest2.json.version.events.find((e) => e.title === '动员会').source, REDACTED_SOURCE);
});

test('重复确认幂等：返回已遮盖状态，不重复登记', async () => {
  await setupTwoVersions();
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });

  // 即便携的是过期版本号，重复确认也返回已遮盖状态（幂等优先于冲突）
  const again = await call('POST', '/api/editor/redaction', {
    body: { source: ` ${SRC} `, currentVersionNo: 1 },
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyRedacted, true);
  assert.strictEqual(again.json.totalHitCount, 5);

  const n = mem.prepare('SELECT COUNT(*) AS n FROM source_redactions WHERE source_text = ?').get(SRC).n;
  assert.strictEqual(n, 1);

  // 清单接口（编辑者，含原文）
  const list = await call('GET', '/api/editor/redactions');
  assert.strictEqual(list.json.redactions.length, 1);
  assert.strictEqual(list.json.redactions[0].source, SRC);
  assert.strictEqual(list.json.redactions[0].editor, '');
});

test('遮盖不推进草稿修订号（不触碰草稿区）', async () => {
  await setupTwoVersions();
  const before = (await call('GET', '/api/editor/state')).json.draftRevisionNo;
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 2 } });
  const after = (await call('GET', '/api/editor/state')).json.draftRevisionNo;
  assert.strictEqual(before, after);
});

test('尚无发布版本也可预览（命中 0）并确认登记；之后发布即自动遮盖', async () => {
  const e1 = await makeEvent('草稿事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: SRC });
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.status, 200);
  assert.strictEqual(preview.json.versionCount, 0);
  assert.strictEqual(preview.json.totalHitCount, 0);
  assert.strictEqual(preview.json.draft.claimHitCount, 1); // 草稿命中仅供参考

  const confirm = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 0 },
  });
  assert.strictEqual(confirm.status, 200);
  assert.strictEqual(confirm.json.currentVersionNo, 0);

  await publish([{ eventId: e1, claimId: c1 }], 0);
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, REDACTED_SOURCE);
});

test('精确匹配：部分包含 / 前后多字的出处不被遮盖', async () => {
  const e1 = await makeEvent('事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: `${SRC}；另见档案第 3 页` });
  await publish([{ eventId: e1, claimId: c1 }], 0);
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.totalEventHitCount, 0);
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, `${SRC}；另见档案第 3 页`);
});

// ============ 本轮修复：库存出处带首尾空白时的「首尾空白等同」命中规则 ============
// 手工录入、整理包导入、并行会话保存的出处都可能带首尾空白（录入端保留原文）。
// 预览 / 确认 / 公开读出统一按「各自去除首尾空白后逐字相等」判定命中；
// 内部空白与其他文字仍须逐字精确，部分包含不命中。

test('库存出处带首尾空白：预览命中事件主张、先于关系与草稿提示；确认后访客遮盖、原文保留', async () => {
  const PAD_SRC = `  ${SRC}\n`; // 手工录入残留的出处原文（前导空格 + 尾部换行）
  const PAD_REL = `\t${SRC} `;
  const e1 = await makeEvent('动员会');
  const e2 = await makeEvent('通水会');
  const c1 = await makeClaim(e1, { precision: 'day', year: 1958, month: 9, day: 12, source: PAD_SRC });
  const c2 = await makeClaim(e2, { precision: 'month', year: 1959, month: 5, source: SRC2 });
  await makeRel(e1, e2, PAD_REL);
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  // 编辑者按记忆中的原文（不带空白）预览：命中带空白的库存出处
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.json));
  assert.strictEqual(preview.json.source, SRC);
  assert.strictEqual(preview.json.totalEventHitCount, 1);
  assert.strictEqual(preview.json.totalRelationHitCount, 1);
  assert.strictEqual(preview.json.totalHitCount, 2);
  assert.strictEqual(preview.json.versions[0].eventHits[0].title, '动员会');
  assert.deepStrictEqual(
    Object.keys(preview.json.versions[0].eventHits[0]).sort(),
    ['eventId', 'sortOrder', 'title'].sort()
  );
  // 草稿提示按同一规则命中（草稿区仍是带空白原文）
  assert.strictEqual(preview.json.draft.claimHitCount, 1);
  assert.strictEqual(preview.json.draft.relationHitCount, 1);

  const confirm = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: preview.json.currentVersionNo },
  });
  assert.strictEqual(confirm.status, 200, JSON.stringify(confirm.json));
  assert.strictEqual(confirm.json.totalHitCount, 2);

  // 访客最新年表与历史版本：命中处遮盖，未命中不变
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '动员会').source, REDACTED_SOURCE);
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '通水会').source, SRC2);
  assert.strictEqual(latest.json.version.relations[0].source, REDACTED_SOURCE);
  const v1 = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(v1.json.version.events.find((e) => e.title === '动员会').source, REDACTED_SOURCE);
  assert.strictEqual(v1.json.version.relations[0].source, REDACTED_SOURCE);

  // 快照与草稿中的出处原文（含首尾空白）保留；编辑者原文视图不变
  const raw = await call('GET', '/api/editor/versions/1/raw');
  assert.strictEqual(raw.json.version.events.find((e) => e.title === '动员会').source, PAD_SRC);
  assert.strictEqual(raw.json.version.relations[0].source, PAD_REL);
  const row = mem.prepare('SELECT source FROM version_events WHERE event_id = ?').get(e1);
  assert.strictEqual(row.source, PAD_SRC);
  const state = await call('GET', '/api/editor/state');
  assert.strictEqual(state.json.events.find((e) => e.id === e1).claims[0].source, PAD_SRC);
});

test('内部空白与其余文字仍须逐字精确：内部空白不同 / 部分包含不命中也不遮盖', async () => {
  const INNER = '李宝山 口述，2021-07-05 访谈'; // 与 SRC 仅内部空白不同
  const e1 = await makeEvent('事件甲');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: INNER });
  const e2 = await makeEvent('事件乙');
  const c2 = await makeClaim(e2, { precision: 'year', year: 1959, source: `${SRC}；另见档案第 3 页` });
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.totalHitCount, 0);
  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '事件甲').source, INNER);
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '事件乙').source, `${SRC}；另见档案第 3 页`);
});

test('整理包导入的带首尾空白出处：发布后同样命中并遮盖，快照原文保留', async () => {
  const PAD = `\n  ${SRC}  `;
  const bundle = {
    batchId: `batch-ws-${Date.now()}`,
    events: [
      { key: 'ev-a', title: '导入事件甲', claims: [{ precision: 'year', year: 1958, source: PAD }] },
      { key: 'ev-b', title: '导入事件乙', claims: [{ precision: 'year', year: 1959, source: SRC2 }] },
    ],
    relations: [{ earlierKey: 'ev-a', laterKey: 'ev-b', source: ` ${SRC}\t` }],
  };
  const preview = await call('POST', '/api/editor/import-preview', { body: bundle });
  assert.strictEqual(preview.status, 200, JSON.stringify(preview.json));
  const confirm = await call('POST', '/api/editor/import', {
    body: { bundle, fingerprint: preview.json.fingerprint, draftRevisionNo: preview.json.draftRevisionNo },
  });
  assert.strictEqual(confirm.status, 201, JSON.stringify(confirm.json));
  const [ea, eb] = confirm.json.idMap.events;
  await publish(
    [
      { eventId: ea.eventId, claimId: ea.claimIds[0] },
      { eventId: eb.eventId, claimId: eb.claimIds[0] },
    ],
    0
  );

  const rp = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(rp.json.totalEventHitCount, 1);
  assert.strictEqual(rp.json.totalRelationHitCount, 1);
  const cf = await call('POST', '/api/editor/redaction', {
    body: { source: ` ${SRC} `, currentVersionNo: rp.json.currentVersionNo },
  });
  assert.strictEqual(cf.status, 200);
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '导入事件甲').source, REDACTED_SOURCE);
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '导入事件乙').source, SRC2);
  assert.strictEqual(latest.json.version.relations[0].source, REDACTED_SOURCE);
  const row = mem.prepare('SELECT source FROM version_events WHERE event_id = ?').get(ea.eventId);
  assert.strictEqual(row.source, PAD); // 快照原文（含空白）未改写
});

test('并行编辑会话保存的带首尾空白出处：提交并发布后同样命中并遮盖', async () => {
  const PAD = ` ${SRC}\n`;
  const s = await call('POST', '/api/editor/sessions', { body: { editor: '甲' } });
  const sid = s.json.session.sessionId;
  const ops = await call('POST', `/api/editor/sessions/${sid}/ops`, {
    body: {
      ops: [
        { op: 'create_event', tempId: 'ev1', title: '会话事件' },
        { op: 'create_claim', tempId: 'cl1', eventRef: 'ev1', precision: 'year', year: 1958, source: PAD },
      ],
    },
  });
  assert.strictEqual(ops.status, 201, JSON.stringify(ops.json));
  const commit = await call('POST', `/api/editor/sessions/${sid}/commit`);
  assert.strictEqual(commit.status, 200, JSON.stringify(commit.json));
  const eventId = commit.json.idMap.events[0].eventId;
  const claimId = commit.json.idMap.claims[0].claimId;

  // 草稿提示命中（库存出处带空白）
  const preview = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(preview.json.draft.claimHitCount, 1);

  await publish([{ eventId, claimId }], 0);
  const p2 = await call('POST', '/api/editor/redaction-preview', { body: { source: SRC } });
  assert.strictEqual(p2.json.totalEventHitCount, 1);
  await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: p2.json.currentVersionNo },
  });
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events[0].source, REDACTED_SOURCE);
});

test('专题路线公开读出同步遮盖带首尾空白的出处；编辑者路线原文视图不变', async () => {
  const PAD = ` ${SRC} `;
  const e1 = await makeEvent('起点');
  const e2 = await makeEvent('终点');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: PAD });
  const c2 = await makeClaim(e2, { precision: 'year', year: 1959, source: SRC2 });
  await makeRel(e1, e2, `${SRC}\n`);
  await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 0);

  const route = await call('POST', '/api/editor/routes', {
    body: { title: '测试路线', versionNo: 1, anchorEventIds: [e1, e2] },
  });
  assert.strictEqual(route.status, 201, JSON.stringify(route.json));
  const routeNo = route.json.route.routeNo;

  await call('POST', '/api/editor/redaction', { body: { source: SRC, currentVersionNo: 1 } });

  const pub = await call('GET', `/api/public/routes/${routeNo}`, { token: null });
  assert.strictEqual(pub.status, 200);
  assert.strictEqual(pub.json.route.events.find((e) => e.eventId === e1).source, REDACTED_SOURCE);
  assert.strictEqual(pub.json.route.events.find((e) => e.eventId === e2).source, SRC2);
  assert.strictEqual(pub.json.route.relations[0].source, REDACTED_SOURCE);

  const raw = await call('GET', `/api/editor/routes/${routeNo}/raw`);
  assert.strictEqual(raw.json.route.events.find((e) => e.eventId === e1).source, PAD);
  assert.strictEqual(raw.json.route.relations[0].source, `${SRC}\n`);
});

test('勘误附记出处同样按「首尾空白等同」遮盖；编辑者附记原文不变', async () => {
  const e1 = await makeEvent('事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: SRC2 });
  await publish([{ eventId: e1, claimId: c1 }], 0);
  const err = await call('POST', '/api/editor/errata', {
    body: { versionNo: 1, targetType: 'event', targetId: e1, note: '日期待核', source: SRC },
  });
  assert.strictEqual(err.status, 201, JSON.stringify(err.json));

  // 以带首尾空白的文本登记遮盖（登记时去除首尾空白）
  const cf = await call('POST', '/api/editor/redaction', {
    body: { source: ` ${SRC}\n`, currentVersionNo: 1 },
  });
  assert.strictEqual(cf.status, 200);
  const pub = await call('GET', '/api/public/versions/1', { token: null });
  assert.strictEqual(pub.json.version.errata[0].source, REDACTED_SOURCE);
  assert.strictEqual(pub.json.version.events[0].source, SRC2); // 未命中不变
  const raw = await call('GET', '/api/editor/versions/1/raw');
  assert.strictEqual(raw.json.version.errata[0].source, SRC);
});

test('登记后以后发布的含首尾空白变体出处的新版本自动遮盖；重复确认（空白变体）幂等', async () => {
  const e1 = await makeEvent('首版事件');
  const c1 = await makeClaim(e1, { precision: 'year', year: 1958, source: SRC2 });
  await publish([{ eventId: e1, claimId: c1 }], 0);

  // 先登记遮盖（此时任何版本都还没有该出处）
  const confirm = await call('POST', '/api/editor/redaction', {
    body: { source: SRC, currentVersionNo: 1 },
  });
  assert.strictEqual(confirm.status, 200);

  // 之后录入的带首尾空白出处，发布新版后访客视图自动遮盖（读出时动态比对）
  const e2 = await makeEvent('新事件');
  const c2 = await makeClaim(e2, { precision: 'year', year: 1959, source: `  ${SRC}\t` });
  const pub = await publish([{ eventId: e1, claimId: c1 }, { eventId: e2, claimId: c2 }], 1);
  assert.strictEqual(pub.versionNo, 2);
  const latest = await call('GET', '/api/public/chronicle', { token: null });
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '新事件').source, REDACTED_SOURCE);
  assert.strictEqual(latest.json.version.events.find((e) => e.title === '首版事件').source, SRC2);

  // 重复确认（首尾空白变体）幂等：alreadyRedacted，不重复登记
  const again = await call('POST', '/api/editor/redaction', {
    body: { source: `\n${SRC}  `, currentVersionNo: 2 },
  });
  assert.strictEqual(again.status, 200);
  assert.strictEqual(again.json.alreadyRedacted, true);
  const n = mem.prepare('SELECT COUNT(*) AS n FROM source_redactions').get().n;
  assert.strictEqual(n, 1);
});
