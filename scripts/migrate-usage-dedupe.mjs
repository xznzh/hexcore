/**
 * 一次性迁移：合并 usage 表中的重复行并重建唯一索引。
 *
 * 背景：早期 `addUsage` 是「先查再改/插」的非原子写法，同一个 (user_id, period)
 * 可能产生多行。后来改成 `ON CONFLICT DO UPDATE`，依赖 idx_usage_user_period 唯一索引。
 *
 * 这段去重原先写在 lib/db.ts 的 ALTER_STMTS 里 —— 意味着**每次进程启动**都会全表扫
 * usage 并执行 DELETE。三个问题：
 *   1. 启动路径承担写放大，表越大越慢；
 *   2. DELETE 一旦出错没有回滚余地；
 *   3. 这段「一次性修数」永久留在了冷启动链路上。
 *
 * V8.2 起改为本脚本，需要时手动执行（幂等，可反复跑）。
 *
 * 用法：
 *   node scripts/migrate-usage-dedupe.mjs           # 执行
 *   node scripts/migrate-usage-dedupe.mjs --dry-run # 只看会删多少行，不写入
 */
import postgres from 'postgres';

const dryRun = process.argv.includes('--dry-run');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('[migrate] 未设置 DATABASE_URL，无法连接数据库');
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

try {
  const before = await sql`SELECT count(*)::int AS n FROM usage`;
  const dup = await sql`
    SELECT count(*)::int AS n FROM (
      SELECT user_id, period FROM usage GROUP BY user_id, period HAVING count(*) > 1
    ) t
  `;
  const extra = await sql`
    SELECT COALESCE(sum(cnt - 1), 0)::int AS n FROM (
      SELECT count(*) AS cnt FROM usage GROUP BY user_id, period HAVING count(*) > 1
    ) t
  `;

  console.log(
    `[migrate] 当前 ${before[0].n} 行；重复组 ${dup[0].n} 个，多余行 ${extra[0].n} 条`,
  );

  if (dryRun) {
    console.log('[migrate] --dry-run：未做任何写入');
  } else if (extra[0].n === 0) {
    console.log('[migrate] 无重复行，跳过合并');
  } else {
    // 单事务：合并与删除必须同时生效，否则会出现「已累加但没删行」的中间态
    await sql.begin(async (tx) => {
      await tx`
        WITH agg AS (
          SELECT user_id, period, MIN(id) AS keep_id, SUM(tokens_used) AS total
          FROM usage GROUP BY user_id, period
        )
        UPDATE usage u SET tokens_used = agg.total
        FROM agg WHERE u.id = agg.keep_id
      `;
      await tx`
        DELETE FROM usage
        WHERE id NOT IN (SELECT MIN(id) FROM usage GROUP BY user_id, period)
      `;
    });
    console.log(`[migrate] 已合并并删除 ${extra[0].n} 条重复行`);
  }

  // 唯一索引是 upsert 的前置条件：缺了它 addUsage 每次都会抛
  // 「no unique or exclusion constraint matching the ON CONFLICT specification」，
  // 而调用方是 fire-and-forget，表现为「用量永远是 0」，极难发现。
  if (!dryRun) {
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_user_period ON usage(user_id, period)`;
    console.log('[migrate] idx_usage_user_period 就绪');
  }

  const after = await sql`SELECT count(*)::int AS n FROM usage`;
  console.log(`[migrate] 完成，现有 ${after[0].n} 行`);
} catch (e) {
  console.error('[migrate] 失败：', e?.message || e);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
