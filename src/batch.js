'use strict';

/**
 * 批量交接预演引擎（只读，不落盘）。
 *
 * 把整批交接记录追加到当前数据之后，沿用核验引擎的「同分钟唯一链」规则重放，
 * 对批次涉及的每件道具给出「提交前 / 提交后」对照：
 *  - 提交后持有人（链可重放时），或冲突详情（类型、分钟、原因）；
 *  - 冲突记录定位：属于本批次的行号（#1、#2…）与既有记录编号；
 *  - 受影响道具「原本已冲突」或「合并后冲突」时给出 blockReason —— 禁止提交。
 *
 * 预演结果只是即时演算；提交接口用 dataVersion（数据版本号）+ batchHash
 * （整批内容指纹）核对「预演时的数据与整批内容」均未变化后，才一次写入全部记录。
 */

const crypto = require('crypto');
const { verifyProp } = require('./verify');

/** 预演中批次记录使用的合成 id 前缀（batch_行下标），用于把冲突记录映射回批次行号 */
const BATCH_ID_PREFIX = 'batch_';

/** 规范化批次行（假定已通过单条记录校验），保证哈希与重放、落盘的内容一致 */
function normalizeRows(rows) {
  return rows.map((r) => ({
    propId: r.propId,
    minute: r.minute,
    from: r.from,
    to: r.to,
    note: r.note || '',
  }));
}

/** 整批内容指纹：提交时与预演时比对，内容有任何改变则要求重新预演 */
function hashBatch(rows) {
  return crypto.createHash('sha256').update(JSON.stringify(normalizeRows(rows))).digest('hex');
}

function endMinuteOf(records) {
  return records.reduce((m, r) => Math.max(m, Number(r.minute) || 0), 0);
}

function pickConflict(conflict) {
  if (!conflict) return null;
  return {
    type: conflict.type,
    minute: conflict.minute,
    holder: conflict.holder,
    reason: conflict.reason,
    records: conflict.records,
  };
}

/**
 * 预演整批交接记录。
 *
 * @param {{props: Array, records: Array}} data 当前数据（只读，不会被修改）
 * @param {Array<{propId: string, minute: number, from: string, to: string, note?: string}>} rows
 *        已通过单条记录校验的批次行
 * @returns {{canCommit: boolean, rows: Array, props: Array, summary: object}}
 */
function rehearseBatch(data, rows) {
  const props = data.props || [];
  const existing = data.records || [];
  const normalized = normalizeRows(rows);

  // 批次记录追加在既有记录之后：createdAt 接续现有最大值，保证合并后重放顺序稳定
  const base = existing.reduce((m, r) => Math.max(m, r.createdAt || 0), 0);
  const batchRecords = normalized.map((r, i) => ({
    id: `${BATCH_ID_PREFIX}${i}`,
    ...r,
    createdAt: base + 1 + i,
  }));
  const merged = [...existing, ...batchRecords];
  const endBefore = endMinuteOf(existing);
  const endAfter = endMinuteOf(merged);

  // 批次涉及的道具（按首次出现顺序），并记录每件道具对应的批次行号（从 1 开始）
  const affectedIds = [];
  const rowsNosByProp = new Map();
  normalized.forEach((r, i) => {
    if (!rowsNosByProp.has(r.propId)) {
      rowsNosByProp.set(r.propId, []);
      affectedIds.push(r.propId);
    }
    rowsNosByProp.get(r.propId).push(i + 1);
  });

  const propResults = affectedIds.map((propId) => {
    const prop = props.find((p) => p.id === propId);
    const before = verifyProp(prop, existing, endBefore);
    const after = verifyProp(prop, merged, endAfter);

    // 合并后冲突的记录定位：拆分为「批次行号」与「既有记录编号」
    let afterConflict = null;
    if (after.conflict) {
      const batchRows = [];
      const existingRecordIds = [];
      after.conflict.records.forEach((id) => {
        const sid = String(id);
        if (sid.startsWith(BATCH_ID_PREFIX)) {
          batchRows.push(Number(sid.slice(BATCH_ID_PREFIX.length)) + 1);
        } else {
          existingRecordIds.push(id);
        }
      });
      afterConflict = { ...pickConflict(after.conflict), batchRows, existingRecordIds };
    }

    let blockReason = null;
    if (before.conflict) {
      blockReason = `原本已冲突：${before.conflict.reason} 请先处理该道具的现有冲突，再提交批量交接。`;
    } else if (after.conflict) {
      blockReason = `合并后冲突：${after.conflict.reason}`;
    }

    return {
      propId,
      propName: prop ? prop.name : propId,
      batchRows: rowsNosByProp.get(propId),
      before: { status: before.status, holder: before.holder, conflict: pickConflict(before.conflict) },
      after: { status: after.status, holder: after.holder, conflict: afterConflict },
      blockReason,
    };
  });

  const blockedProps = propResults.filter((p) => p.blockReason).length;
  return {
    canCommit: blockedProps === 0,
    rows: normalized,
    props: propResults,
    summary: {
      rowCount: normalized.length,
      affectedProps: propResults.length,
      blockedProps,
    },
  };
}

module.exports = { BATCH_ID_PREFIX, normalizeRows, hashBatch, rehearseBatch };
