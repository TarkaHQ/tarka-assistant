import postgres from 'postgres';
import { config } from '../config.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Sql = postgres.Sql<any>;

let sqlInstance: Sql | undefined;

/** Shared connection pool. Values are returned with camelCase-free column names (as stored). */
export function db(): Sql {
  sqlInstance ??= postgres(config().databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    types: {
      // int8 columns (usage counters, bigserial ids) as JS numbers; values stay well below 2^53.
      int8: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    },
    transform: { undefined: null },
  });
  return sqlInstance!;
}

export async function closeDb(): Promise<void> {
  if (sqlInstance) {
    await sqlInstance.end({ timeout: 5 });
    sqlInstance = undefined;
  }
}
