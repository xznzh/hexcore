// 全量重置：清空数据库 public schema 全部业务表 + 清空 data/files 上传文件目录。
// 用法：node scripts/reset-all-data.mjs [--yes]
// ⚠️ 破坏性操作，不可恢复。首次加 --yes 才会执行；不带参数仅预览将要影响的表。
// 重置后重启应用：首个注册的用户自动成为管理员；预置模型会在首次启动时自动补齐。
import { rmSync, readdirSync, existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import postgres from 'postgres';

// 从 .env.local 读取配置（避免依赖 dotenv）
const envText = readFileSync(new URL('../.env.local', import.meta.url), 'utf8');
function env(name) {
  const m = envText.match(new RegExp('^' + name + '=(.*)$', 'm'));
  return m ? m[1].trim() : undefined;
}

const url = process.env.DATABASE_URL || env('DATABASE_URL') || 'postgres://postgres:postgres@localhost:5432/ai_agent_platform';
const confirmed = process.argv.includes('--yes');

const sql = postgres(url);
try {
  const tables = (
    await sql`
      select tablename from pg_tables
      where schemaname = 'public'
      order by tablename
    `
  ).map((r) => r.tablename);

  if (tables.length === 0) {
    console.log('public schema 中没有表，无需重置。');
  } else {
    console.log('将清空以下表：\n  ' + tables.join('\n  '));
    if (!confirmed) {
      console.log('\n（预览模式，未执行。确认无误后加 --yes 运行。）');
    } else {
      const list = tables.map((t) => `"public"."${t}"`).join(', ');
      await sql.unsafe(`truncate table ${list} cascade`);
      console.log('\n已清空。清空后各行数：');
      for (const t of tables) {
        const c = (await sql.unsafe(`select count(*)::int as n from "public"."${t}"`))[0].n;
        console.log(`  ${t}: ${c}`);
      }
    }
  }

  // 清空上传文件目录 data/files（保留目录本身）
  const filesDir = fileURLToPath(new URL('../data/files', import.meta.url));
  if (existsSync(filesDir)) {
    const entries = readdirSync(filesDir);
    console.log(`\ndata/files 现有 ${entries.length} 个条目。`);
    if (confirmed) {
      for (const e of entries) rmSync(filesDir + '/' + e, { recursive: true, force: true });
      console.log(`data/files 已清空（删除 ${entries.length} 个条目）。`);
    } else {
      console.log('（预览模式未删除）');
    }
  } else {
    console.log('\ndata/files 目录不存在，跳过。');
  }
} finally {
  await sql.end();
}
