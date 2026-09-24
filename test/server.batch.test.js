'use strict';

/* 批量预演 / 提交接口集成测试：node test/server.batch.test.js
 * 使用独立临时数据文件启动真实 HTTP 服务，覆盖：
 * 预演不落盘、提交一次写入、版本过期 / 内容改变要求重新预演、冲突禁止提交。
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_FILE = path.join(os.tmpdir(), `prop-batch-test-${process.pid}-${Date.now()}.json`);
process.env.DATA_FILE = DATA_FILE;

const app = require('../server');

let server;
let base;
let passed = 0;

async function api(method, url, body) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, body: json };
}

async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function recordCount() {
  const { body } = await api('GET', '/api/records');
  return body.length;
}

async function main() {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  try {
    // 初始演示数据：青龙剑 p_sword（已归仓）、折扇 p_fan（第5分钟歧义冲突）、
    // 宫灯 p_lantern（断链冲突）、御印 p_seal（孙七持有未归仓），共 12 条记录
    const initialCount = await recordCount();
    assert.strictEqual(initialCount, 12);

    // 1. 预演：合并重放并逐件给出提交后持有人；预演不落盘
    let rehearsal;
    await test('预演：返回数据版本与整批指纹，逐件给出提交后持有人，且不落盘', async () => {
      const rows = [
        { propId: 'p_sword', minute: 20, from: '仓库', to: '张三' },
        { propId: 'p_sword', minute: 25, from: '张三', to: '仓库' },
        { propId: 'p_seal', minute: 30, from: '孙七', to: '仓库' },
      ];
      const { status, body } = await api('POST', '/api/records/batch/rehearse', { rows });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.canCommit, true);
      assert.strictEqual(typeof body.dataVersion, 'number');
      assert.strictEqual(typeof body.batchHash, 'string');
      assert.strictEqual(body.summary.affectedProps, 2);
      const sword = body.props.find((p) => p.propId === 'p_sword');
      assert.deepStrictEqual(sword.batchRows, [1, 2]);
      assert.strictEqual(sword.after.holder, '仓库');
      const seal = body.props.find((p) => p.propId === 'p_seal');
      assert.strictEqual(seal.before.status, 'NOT_RETURNED');
      assert.strictEqual(seal.after.status, 'RETURNED');
      rehearsal = body;
      // 不落盘：记录数不变
      assert.strictEqual(await recordCount(), initialCount);
    });

    // 2. 提交通过：一次写入全部记录，记录列表与核验可见
    await test('提交：一次写入全部记录，核验随之更新', async () => {
      const { status, body } = await api('POST', '/api/records/batch/commit', {
        rows: rehearsal.rows,
        dataVersion: rehearsal.dataVersion,
        batchHash: rehearsal.batchHash,
      });
      assert.strictEqual(status, 201);
      assert.strictEqual(body.created, 3);
      assert.strictEqual(await recordCount(), initialCount + 3);
      const { body: verify } = await api('GET', '/api/verify');
      const seal = verify.results.find((r) => r.propId === 'p_seal');
      assert.strictEqual(seal.status, 'RETURNED');
    });

    // 3. 数据版本过期：预演后数据被修改 -> 提交拒绝，要求重新预演
    await test('提交：预演后数据被修改 -> 409 要求重新预演且不写入', async () => {
      const rows = [{ propId: 'p_sword', minute: 40, from: '仓库', to: '甲' }];
      const { body: r1 } = await api('POST', '/api/records/batch/rehearse', { rows });
      assert.strictEqual(r1.canCommit, true);
      // 预演后另一操作改动了数据（单条录入），版本号递增
      const add = await api('POST', '/api/records', {
        propId: 'p_sword', minute: 35, from: '仓库', to: '乙',
      });
      assert.strictEqual(add.status, 201);
      const before = await recordCount();
      const { status, body } = await api('POST', '/api/records/batch/commit', {
        rows: r1.rows,
        dataVersion: r1.dataVersion,
        batchHash: r1.batchHash,
      });
      assert.strictEqual(status, 409);
      assert.strictEqual(body.code, 'REHEARSAL_STALE');
      assert.ok(body.error.includes('重新预演'));
      assert.strictEqual(await recordCount(), before); // 未写入任何批次记录
    });

    // 4. 批次内容改变：指纹不符 -> 409 要求重新预演
    await test('提交：批次内容与预演不一致 -> 409 要求重新预演且不写入', async () => {
      const rows = [{ propId: 'p_sword', minute: 50, from: '仓库', to: '甲' }];
      const { body: r1 } = await api('POST', '/api/records/batch/rehearse', { rows });
      const tampered = [{ propId: 'p_sword', minute: 51, from: '仓库', to: '甲' }]; // 分钟被改
      const before = await recordCount();
      const { status, body } = await api('POST', '/api/records/batch/commit', {
        rows: tampered,
        dataVersion: r1.dataVersion,
        batchHash: r1.batchHash,
      });
      assert.strictEqual(status, 409);
      assert.strictEqual(body.code, 'REHEARSAL_CHANGED');
      assert.strictEqual(await recordCount(), before);
    });

    // 5. 受影响道具原本已冲突：预演标明原因并禁止提交；强行提交也被拒绝
    await test('预演/提交：道具原本已冲突 -> 标明原因并禁止提交', async () => {
      const rows = [{ propId: 'p_fan', minute: 6, from: '王五', to: '仓库' }];
      const { status, body } = await api('POST', '/api/records/batch/rehearse', { rows });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.canCommit, false);
      assert.ok(body.props[0].blockReason.includes('原本已冲突'));
      const before = await recordCount();
      const commit = await api('POST', '/api/records/batch/commit', {
        rows: body.rows,
        dataVersion: body.dataVersion,
        batchHash: body.batchHash,
      });
      assert.strictEqual(commit.status, 409);
      assert.strictEqual(commit.body.code, 'REHEARSAL_CONFLICT');
      assert.strictEqual(await recordCount(), before);
    });

    // 6. 合并后冲突：定位批次行号，禁止提交
    await test('预演：合并后同分钟歧义 -> 定位批次行号并禁止提交', async () => {
      const rows = [
        { propId: 'p_seal', minute: 31, from: '仓库', to: '甲' },
        { propId: 'p_seal', minute: 31, from: '仓库', to: '乙' },
      ];
      const { status, body } = await api('POST', '/api/records/batch/rehearse', { rows });
      assert.strictEqual(status, 200);
      assert.strictEqual(body.canCommit, false);
      const c = body.props[0].after.conflict;
      assert.strictEqual(c.type, 'AMBIGUOUS');
      assert.deepStrictEqual(c.batchRows, [1, 2]);
      assert.ok(body.props[0].blockReason.includes('合并后冲突'));
    });

    // 7. 沿用单条记录校验：错误信息带批次行号
    await test('预演：沿用单条校验，错误信息定位批次行号', async () => {
      const bad1 = await api('POST', '/api/records/batch/rehearse', {
        rows: [
          { propId: 'p_seal', minute: 31, from: '仓库', to: '甲' },
          { propId: 'p_seal', minute: 32, from: '甲', to: '甲' },
        ],
      });
      assert.strictEqual(bad1.status, 400);
      assert.ok(bad1.body.error.includes('第 2 行'));
      assert.ok(bad1.body.error.includes('交出者与接收者不能相同'));

      const bad2 = await api('POST', '/api/records/batch/rehearse', {
        rows: [{ propId: 'p_seal', minute: -1, from: '仓库', to: '甲' }],
      });
      assert.strictEqual(bad2.status, 400);
      assert.ok(bad2.body.error.includes('第 1 行'));

      const bad3 = await api('POST', '/api/records/batch/rehearse', { rows: [] });
      assert.strictEqual(bad3.status, 400);

      const bad4 = await api('POST', '/api/records/batch/rehearse', {
        rows: [{ propId: 'p_ghost', minute: 1, from: '仓库', to: '甲' }],
      });
      assert.strictEqual(bad4.status, 400);
      assert.ok(bad4.body.error.includes('请选择已登记的道具'));
    });

    // 8. 全部失败场景之后：除第 2、3 步的成功写入外没有留下任何部分记录
    await test('原子性：失败的提交不留下部分记录', async () => {
      assert.strictEqual(await recordCount(), initialCount + 3 + 1);
    });
  } finally {
    server.close();
    fs.rmSync(DATA_FILE, { force: true });
  }

  console.log(`\n全部 ${passed} 个批量接口测试通过 ✔`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
