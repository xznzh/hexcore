/**
 * 幂等账本（DB 层）端到端验证。
 *
 * 为什么必须单独一条真库用例：内存层的行为已经被单测覆盖，但「落库」这件事的价值
 * 恰恰在于**跨进程/重启**——而单测进程里内存 Map 一直活着，永远看不出账本到底有没有生效。
 * 所以这里刻意在两次调用之间清空内存，强制走 DB 分支。
 *
 * 门控方式与 pgvector 用例一致：默认跳过，显式开启才跑，且只连隔离库。
 *   QA_IDEM_E2E=1 npx vitest run tests/idempotency-db-e2e.test.ts --config vitest.config.ts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';

const RUN = process.env.QA_IDEM_E2E === '1';
const QA_DB =
  process.env.QA_DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/aap_qa_conv';
const PREFIX = '__qa_idem__';

describe.skipIf(!RUN)('幂等账本 DB 层（真实 PG）', () => {
  let sql: any;
  let dbmod: typeof import('../lib/db');
  let idem: typeof import('../lib/agent/idempotency');

  beforeAll(async () => {
    try {
      for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !/^\s*#/.test(line) && !process.env[m[1]]) {
          process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
      }
    } catch {
      /* 无 .env.local 时用默认连接串 */
    }
    process.env.DATABASE_URL = QA_DB;
    process.env.IDEMPOTENCY_STORE = 'db';

    const postgres = (await import('postgres')).default;
    sql = postgres(QA_DB, { max: 2, connect_timeout: 5 });
    dbmod = await import('../lib/db');
    await dbmod.ensureInit();
    idem = await import('../lib/agent/idempotency');
  }, 120_000);

  afterAll(async () => {
    if (sql) {
      await sql`delete from idempotency_keys where key like ${PREFIX + '%'}`;
      await sql.end();
    }
  });

  it('首次执行写入 done，清空内存后仍能命中账本（跨进程/重启语义）', async () => {
    const key = PREFIX + 'cross_process';
    let calls = 0;
    const fn = async () => {
      calls++;
      return { ok: true, n: calls };
    };

    const a = await idem.withIdempotency(key, fn);
    expect(a.deduped).toBe(false);
    expect(a.value).toEqual({ ok: true, n: 1 });

    const row = (await sql`select status, result from idempotency_keys where key = ${key}`)[0];
    expect(row.status).toBe('done');

    // 关键：清空进程内 Map，模拟「另一个进程 / 重启之后」
    idem.resetIdempotencyForTests();

    const b = await idem.withIdempotency(key, fn);
    expect(b.deduped).toBe(true);
    expect(b.value).toEqual({ ok: true, n: 1 });
    expect(calls).toBe(1);
  }, 60_000);

  it('失败会释放账本条目，允许重试', async () => {
    const key = PREFIX + 'failure';
    let n = 0;
    const fn = async () => {
      n++;
      if (n === 1) throw new Error('boom');
      return n;
    };

    await expect(idem.withIdempotency(key, fn)).rejects.toThrow('boom');
    const gone = await sql`select 1 from idempotency_keys where key = ${key}`;
    // 失败不是「已完成」：留着就会把一次失败永久固化，用户重试永远拿同一条错误
    expect(gone.length).toBe(0);

    const r = await idem.withIdempotency(key, fn);
    expect(r.deduped).toBe(false);
    expect(r.value).toBe(2);
  }, 60_000);

  it('过期条目可以被重新占用并执行', async () => {
    const key = PREFIX + 'expired';
    await sql`insert into idempotency_keys (key, status, result, created_at, expires_at)
              values (${key}, 'done', ${'{"v":"旧结果"}'}, ${Date.now() - 60_000}, ${Date.now() - 1000})`;

    let calls = 0;
    const r = await idem.withIdempotency(key, async () => {
      calls++;
      return '新结果';
    });
    expect(calls).toBe(1);
    expect(r.deduped).toBe(false);
    expect(r.value).toBe('新结果');
  }, 60_000);

  it('别人正在执行（running 未过期）时，等在超时后自己执行而不是报错', async () => {
    const key = PREFIX + 'running';
    await sql`insert into idempotency_keys (key, status, result, created_at, expires_at)
              values (${key}, 'running', null, ${Date.now()}, ${Date.now() + 60_000})`;

    let calls = 0;
    const r = await idem.withIdempotency(key, async () => {
      calls++;
      return 'done-by-me';
    });
    // 拿不到结果也不能把工具调用判死：宁可重复执行一次，也不能让用户看到硬失败
    expect(calls).toBe(1);
    expect(r.value).toBe('done-by-me');
  }, 60_000);

  it('结果不可序列化时不当作命中，而是重新执行（不能返回空结果给模型）', async () => {
    const key = PREFIX + 'unserializable';
    const circular: any = { a: 1 };
    circular.self = circular;

    const first = await idem.withIdempotency(key, async () => circular);
    expect(first.value).toBe(circular);

    idem.resetIdempotencyForTests();
    let calls = 0;
    const second = await idem.withIdempotency(key, async () => {
      calls++;
      return 'fallback';
    });
    expect(calls).toBe(1);
    expect(second.deduped).toBe(false);
    expect(second.value).toBe('fallback');
  }, 60_000);
});
