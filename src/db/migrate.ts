import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
/** migrations/ sits at the project root, next to src/ and dist/. */
export const MIGRATIONS_DIR = join(here, '..', '..', 'migrations');

/** Applies every migrations/*.sql file not yet recorded, in name order, each in its own transaction. */
export async function migrate(sql: Sql, dir = MIGRATIONS_DIR): Promise<string[]> {
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  // Serialise concurrent starters (server and worker boot together).
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(7316402)`;
    const done = new Set((await tx<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const applied: string[] = [];
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(dir, file), 'utf8');
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
      applied.push(file);
    }
    return applied;
  });
}
