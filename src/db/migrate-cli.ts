import { db, closeDb } from './index.js';
import { migrate } from './migrate.js';

const applied = await migrate(db());
console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Database is up to date');
await closeDb();
