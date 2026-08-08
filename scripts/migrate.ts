/** db/migrations/*.sql 을 이름순으로 한 번씩만 적용한다. */
import fs from 'node:fs';
import path from 'node:path';
import { pool, query, exec } from '../src/lib/core';

async function main() {
  const dir = path.join(process.cwd(), 'db', 'migrations');
  await exec(`create table if not exists _migrations (
    name text primary key,
    applied_at timestamptz not null default now()
  )`);

  const applied = new Set(
    (await query<{ name: string }>(`select name from _migrations`)).map((r) => r.name),
  );
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`  skip  ${file}`);
      continue;
    }
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    const client = await pool().connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query(`insert into _migrations (name) values ($1)`, [file]);
      await client.query('commit');
      console.log(`  apply ${file}`);
      count++;
    } catch (e) {
      await client.query('rollback');
      throw new Error(`${file} 적용 실패: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      client.release();
    }
  }
  console.log(`마이그레이션 완료: ${count}개 적용, ${files.length - count}개 건너뜀`);
  await pool().end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
