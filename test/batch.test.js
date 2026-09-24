'use strict';

/* 批量交接预演引擎单元测试：node test/batch.test.js */

const assert = require('assert');
const { rehearseBatch, hashBatch, normalizeRows } = require('../src/batch');
const { STATUS, CONFLICT, WAREHOUSE } = require('../src/verify');

let seq = 0;
const t = (n) => 1000 + n;

function mkData(props, records) {
  return {
    props: props.map((name, i) => ({ id: `p${i}`, name, note: '', createdAt: t(seq++) })),
    records,
  };
}
function rec(propId, minute, from, to) {
  return { id: `r${seq++}`, propId, minute, from, to, note: '', createdAt: t(seq) };
}
function row(propId, minute, from, to) {
  return { propId, minute, from, to, note: '' };
}

let passed = 0;
function test(name, fn) {
  seq = 0;
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 批次追加后链完整归仓：可提交，逐件给出提交后持有人
test('预演：批次合并后链完整 -> 可提交，提交后持有人为仓库', () => {
  const data = mkData(['剑'], [
    rec('p0', 0, WAREHOUSE, '张三'),
    rec('p0', 3, '张三', '李四'),
  ]);
  const result = rehearseBatch(data, [
    row('p0', 8, '李四', '张三'),
    row('p0', 12, '张三', WAREHOUSE),
  ]);
  assert.strictEqual(result.canCommit, true);
  assert.strictEqual(result.summary.rowCount, 2);
  assert.strictEqual(result.summary.affectedProps, 1);
  const p = result.props[0];
  assert.deepStrictEqual(p.batchRows, [1, 2]);
  assert.strictEqual(p.before.status, STATUS.NOT_RETURNED);
  assert.strictEqual(p.before.holder, '李四');
  assert.strictEqual(p.after.status, STATUS.RETURNED);
  assert.strictEqual(p.after.holder, WAREHOUSE);
  assert.strictEqual(p.blockReason, null);
});

// 2. 批次导致同一分钟多条可接续 -> 合并后冲突，定位批次行号，禁止提交
test('预演：合并后同分钟多条可接续 -> 冲突定位批次行号并禁止提交', () => {
  const data = mkData(['扇'], [rec('p0', 1, WAREHOUSE, '张三')]);
  const result = rehearseBatch(data, [
    row('p0', 5, '张三', '王五'),
    row('p0', 5, '张三', '赵六'),
  ]);
  assert.strictEqual(result.canCommit, false);
  const p = result.props[0];
  assert.strictEqual(p.before.conflict, null);
  assert.strictEqual(p.after.status, STATUS.CONFLICT);
  assert.strictEqual(p.after.conflict.type, CONFLICT.AMBIGUOUS);
  assert.strictEqual(p.after.conflict.minute, 5);
  assert.deepStrictEqual(p.after.conflict.batchRows, [1, 2]);
  assert.deepStrictEqual(p.after.conflict.existingRecordIds, []);
  assert.ok(p.blockReason.includes('合并后冲突'));
});

// 3. 批次断链：交出者不是当前持有人 -> BROKEN，定位到对应批次行
test('预演：批次行交出者对不上当前持有人 -> 断链冲突并定位行号', () => {
  const data = mkData(['灯'], [rec('p0', 2, WAREHOUSE, '王五')]);
  const result = rehearseBatch(data, [
    row('p0', 4, '李四', '钱七'), // 当前持有人是王五，接续不上
  ]);
  assert.strictEqual(result.canCommit, false);
  const p = result.props[0];
  assert.strictEqual(p.after.conflict.type, CONFLICT.BROKEN);
  assert.deepStrictEqual(p.after.conflict.batchRows, [1]);
  assert.ok(p.blockReason.includes('合并后冲突'));
});

// 4. 道具原本已冲突：即使批次行本身可接续，也标明原因并禁止提交
test('预演：道具原本已冲突 -> 标明原本已冲突并禁止提交', () => {
  const data = mkData(['扇'], [
    rec('p0', 1, WAREHOUSE, '张三'),
    rec('p0', 5, '张三', '王五'),
    rec('p0', 5, '张三', '赵六'), // 既有数据第 5 分钟已歧义冲突
  ]);
  const result = rehearseBatch(data, [row('p0', 9, '王五', WAREHOUSE)]);
  assert.strictEqual(result.canCommit, false);
  const p = result.props[0];
  assert.strictEqual(p.before.status, STATUS.CONFLICT);
  assert.ok(p.blockReason.includes('原本已冲突'));
});

// 5. 同分钟链式批次（仓库->甲、甲->仓库 同一分钟）可识别 -> 可提交
test('预演：同分钟链式批次交接可连成唯一链', () => {
  const data = mkData(['枪'], []);
  const result = rehearseBatch(data, [
    row('p0', 7, '甲', WAREHOUSE),
    row('p0', 7, WAREHOUSE, '甲'),
  ]);
  assert.strictEqual(result.canCommit, true);
  assert.strictEqual(result.props[0].after.status, STATUS.RETURNED);
  assert.strictEqual(result.props[0].after.holder, WAREHOUSE);
});

// 6. 多道具批次逐件展示；未涉及道具不出现在结果中
test('预演：多道具逐件给出结论，未涉及道具不出现', () => {
  const data = mkData(['剑', '扇', '灯'], [
    rec('p0', 1, WAREHOUSE, '甲'),
    rec('p2', 2, WAREHOUSE, '乙'),
  ]);
  const result = rehearseBatch(data, [
    row('p0', 3, '甲', WAREHOUSE),
    row('p2', 9, '乙', '丙'),
  ]);
  assert.strictEqual(result.canCommit, true);
  assert.strictEqual(result.props.length, 2);
  assert.deepStrictEqual(result.props.map((p) => p.propId), ['p0', 'p2']);
  assert.strictEqual(result.props[0].after.status, STATUS.RETURNED);
  assert.strictEqual(result.props[1].after.status, STATUS.NOT_RETURNED);
  assert.strictEqual(result.props[1].after.holder, '丙');
});

// 7. 冲突同时涉及既有记录与批次行 -> 两类定位都正确
test('预演：冲突同时涉及既有记录与批次行 -> 分别定位', () => {
  const data = mkData(['印'], [rec('p0', 5, WAREHOUSE, '甲')]);
  const data2 = {
    props: data.props,
    records: [...data.records, { id: 'r_exist', propId: 'p0', minute: 9, from: '甲', to: '乙', note: '', createdAt: 2000 }],
  };
  const result = rehearseBatch(data2, [row('p0', 9, '甲', '丙')]);
  assert.strictEqual(result.canCommit, false);
  const c = result.props[0].after.conflict;
  assert.strictEqual(c.type, CONFLICT.AMBIGUOUS);
  assert.deepStrictEqual(c.batchRows, [1]);
  assert.deepStrictEqual(c.existingRecordIds, ['r_exist']);
});

// 8. 整批内容指纹：内容一致哈希一致；任一字段或顺序变化哈希不同
test('指纹：批次内容或顺序任何变化都改变哈希', () => {
  const rows = [row('p0', 1, '甲', '乙'), row('p1', 2, '丙', '丁')];
  const h = hashBatch(rows);
  assert.strictEqual(hashBatch([row('p0', 1, '甲', '乙'), row('p1', 2, '丙', '丁')]), h);
  assert.notStrictEqual(hashBatch([row('p0', 1, '甲', '乙'), row('p1', 3, '丙', '丁')]), h); // 分钟变了
  assert.notStrictEqual(hashBatch([row('p0', 1, '甲', '丙'), row('p1', 2, '丙', '丁')]), h); // 接收者变了
  assert.notStrictEqual(hashBatch([row('p1', 2, '丙', '丁'), row('p0', 1, '甲', '乙')]), h); // 顺序变了
  assert.notStrictEqual(hashBatch([row('p0', 1, '甲', '乙')]), h); // 行数变了
});

// 9. 预演是纯演算：不修改传入数据（不落盘由接口保证）
test('预演：不修改传入的当前数据', () => {
  const data = mkData(['剑'], [rec('p0', 1, WAREHOUSE, '甲')]);
  const before = JSON.stringify(data);
  rehearseBatch(data, [row('p0', 2, '甲', WAREHOUSE)]);
  assert.strictEqual(JSON.stringify(data), before);
  assert.strictEqual(data.records.length, 1);
});

// 10. 规范化：缺省备注补空串，哈希基于规范化内容
test('规范化：备注缺省按空串处理，哈希与显式空串一致', () => {
  const a = normalizeRows([{ propId: 'p0', minute: 1, from: '甲', to: '乙' }]);
  assert.strictEqual(a[0].note, '');
  const h1 = hashBatch([{ propId: 'p0', minute: 1, from: '甲', to: '乙' }]);
  const h2 = hashBatch([{ propId: 'p0', minute: 1, from: '甲', to: '乙', note: '' }]);
  assert.strictEqual(h1, h2);
});

console.log(`\n全部 ${passed} 个批量预演测试通过 ✔`);
