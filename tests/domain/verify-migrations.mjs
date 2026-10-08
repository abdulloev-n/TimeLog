// Verifies src/database/migrations/*.sql against real SQLite through sql.js.
// Usage (from the repository root): node tests/domain/verify-migrations.mjs
// Requires the dev dependency sql.js. Exits with code 1 on any failed check.
import initSqlJs from 'sql.js';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', '..', 'src', 'database', 'migrations');
const files = readdirSync(migrationsDir).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();

const SQL = await initSqlJs();
const db = new SQL.Database();
db.run('PRAGMA foreign_keys = ON');

const results = [];
const record = (passed, name, detail = '') => results.push({ passed, name, detail });

for (const file of files) {
  const version = Number(file.slice(0, 3));
  db.run('BEGIN');
  try {
    db.run(readFileSync(join(migrationsDir, file), 'utf8'));
    db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', [version, 0]);
    db.run('COMMIT');
    record(true, `apply ${file}`);
  } catch (error) {
    db.run('ROLLBACK');
    record(false, `apply ${file}`, error.message);
  }
}

const scalar = (sql, params = []) => db.exec(sql, params)[0]?.values[0]?.[0];
const accepts = (name, sql, params = []) => {
  try {
    db.run(sql, params);
    record(true, name);
  } catch (error) {
    record(false, name, `rejected: ${error.message}`);
  }
};
const rejects = (name, sql, params = []) => {
  try {
    db.run(sql, params);
    record(false, name, 'accepted, expected rejection');
  } catch (error) {
    record(true, name, error.message.split('\n')[0]);
  }
};

const u = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const T = 1_790_845_200_000;

record(scalar('PRAGMA foreign_keys') === 1, 'foreign keys enabled');
record(scalar('SELECT count(*) FROM schema_migrations') === files.length, 'schema_migrations has one row per file');

// Clients and projects
accepts('insert client', 'INSERT INTO clients (id, name, currency, created_at) VALUES (?, ?, ?, ?)', [u(1), 'Lumen', 'EUR', T]);
rejects('unsupported client currency', 'INSERT INTO clients (id, name, currency, created_at) VALUES (?, ?, ?, ?)', [u(2), 'X', 'JPY', T]);
rejects('untrimmed client name', 'INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)', [u(2), ' X', T]);
rejects('empty client name', 'INSERT INTO clients (id, name, created_at) VALUES (?, ?, ?)', [u(2), '', T]);
rejects('client archived = 2', 'INSERT INTO clients (id, name, archived, created_at) VALUES (?, ?, ?, ?)', [u(2), 'X', 2, T]);
accepts('insert project', 'INSERT INTO projects (id, name, client_id, hourly_rate_minor, currency, created_at) VALUES (?, ?, ?, ?, ?, ?)', [u(10), 'Web', u(1), 2550, 'EUR', T]);
accepts('project with zero rate', 'INSERT INTO projects (id, name, hourly_rate_minor, created_at) VALUES (?, ?, ?, ?)', [u(14), 'Free', 0, T]);
rejects('negative project rate', 'INSERT INTO projects (id, name, hourly_rate_minor, created_at) VALUES (?, ?, ?, ?)', [u(11), 'N', -1, T]);
rejects('fractional project rate', 'INSERT INTO projects (id, name, hourly_rate_minor, created_at) VALUES (?, ?, ?, ?)', [u(11), 'N', 25.5, T]);
rejects('project with unknown client', 'INSERT INTO projects (id, name, client_id, created_at) VALUES (?, ?, ?, ?)', [u(12), 'N', u(99), T]);

// Time entries
accepts('finished entry of 60 000 ms', 'INSERT INTO time_entries (id, project_id, start_at, end_at, hourly_rate_minor, currency) VALUES (?, ?, ?, ?, ?, ?)', [u(20), u(10), T, T + 60_000, 2550, 'EUR']);
rejects('finished entry of 59 999 ms', 'INSERT INTO time_entries (id, start_at, end_at) VALUES (?, ?, ?)', [u(21), T, T + 59_999]);
accepts('finished entry of 24 h', 'INSERT INTO time_entries (id, start_at, end_at) VALUES (?, ?, ?)', [u(22), T + 100_000, T + 100_000 + 86_400_000]);
rejects('finished entry of 24 h + 1 ms', 'INSERT INTO time_entries (id, start_at, end_at) VALUES (?, ?, ?)', [u(23), T, T + 86_400_001]);
rejects('end before start', 'INSERT INTO time_entries (id, start_at, end_at) VALUES (?, ?, ?)', [u(23), T, T - 60_000]);
rejects('projectless entry with a rate', 'INSERT INTO time_entries (id, start_at, end_at, hourly_rate_minor) VALUES (?, ?, ?, ?)', [u(23), T, T + 60_000, 100]);
rejects('projectless entry in EUR', 'INSERT INTO time_entries (id, start_at, end_at, currency) VALUES (?, ?, ?, ?)', [u(23), T, T + 60_000, 'EUR']);
rejects('billable = 2', 'INSERT INTO time_entries (id, start_at, end_at, billable) VALUES (?, ?, ?, ?)', [u(23), T, T + 60_000, 2]);
rejects('entry with unknown project', 'INSERT INTO time_entries (id, project_id, start_at, end_at) VALUES (?, ?, ?, ?)', [u(23), u(98), T, T + 60_000]);
accepts('first running entry', 'INSERT INTO time_entries (id, start_at) VALUES (?, ?)', [u(24), T + 999_999_999]);
rejects('second running entry', 'INSERT INTO time_entries (id, start_at) VALUES (?, ?)', [u(25), T + 999_999_999]);

// Tags and links
accepts('insert tag', 'INSERT INTO tags (id, name) VALUES (?, ?)', [u(30), 'Design']);
rejects('tag differing only in ASCII case', 'INSERT INTO tags (id, name) VALUES (?, ?)', [u(31), 'design']);
accepts('tag with non-ASCII letter', 'INSERT INTO tags (id, name) VALUES (?, ?)', [u(32), 'Étude']);
accepts('documented limitation: non-ASCII case is not folded', 'INSERT INTO tags (id, name) VALUES (?, ?)', [u(33), 'étude']);
accepts('link entry to tag', 'INSERT INTO entry_tags VALUES (?, ?)', [u(20), u(30)]);
accepts('link second entry to tag', 'INSERT INTO entry_tags VALUES (?, ?)', [u(22), u(30)]);
rejects('duplicate link', 'INSERT INTO entry_tags VALUES (?, ?)', [u(20), u(30)]);

// Restrict and cascade
rejects('delete referenced project', 'DELETE FROM projects WHERE id = ?', [u(10)]);
rejects('delete referenced client', 'DELETE FROM clients WHERE id = ?', [u(1)]);
accepts('delete entry', 'DELETE FROM time_entries WHERE id = ?', [u(20)]);
record(scalar('SELECT count(*) FROM entry_tags WHERE entry_id = ?', [u(20)]) === 0, 'entry deletion cascades its tag links');
accepts('delete tag', 'DELETE FROM tags WHERE id = ?', [u(30)]);
record(
  scalar('SELECT count(*) FROM entry_tags') === 0 && scalar('SELECT count(*) FROM time_entries WHERE id = ?', [u(22)]) === 1,
  'tag deletion cascades links and keeps entries',
);
accepts('delete unreferenced project', 'DELETE FROM projects WHERE id = ?', [u(14)]);

// Invoices
const insertInvoice =
  'INSERT INTO invoices (id, number, sequence_number, client_id, period_start, period_end, currency, total_minor, lines_json, sender_json, client_json, issued_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
accepts('insert invoice', insertInvoice, [u(40), 'INV-0001', 1, u(1), T, T + 1000, 'EUR', 100, '[]', '{}', '{}', T]);
rejects('duplicate invoice number', insertInvoice, [u(41), 'INV-0001', 2, u(1), T, T + 1000, 'EUR', 100, '[]', '{}', '{}', T]);
rejects('duplicate sequence number', insertInvoice, [u(41), 'X-0001', 1, u(1), T, T + 1000, 'EUR', 100, '[]', '{}', '{}', T]);
rejects('period_end not after period_start', insertInvoice, [u(41), 'INV-0002', 2, u(1), T, T, 'EUR', 100, '[]', '{}', '{}', T]);
rejects('negative invoice total', insertInvoice, [u(41), 'INV-0002', 2, u(1), T, T + 1, 'EUR', -1, '[]', '{}', '{}', T]);
rejects('invoice for unknown client', insertInvoice, [u(41), 'INV-0002', 2, u(97), T, T + 1, 'EUR', 1, '[]', '{}', '{}', T]);
rejects('update invoice (migration 002)', 'UPDATE invoices SET total_minor = 1');
rejects('delete invoice (migration 002)', 'DELETE FROM invoices');

const failed = results.filter((r) => !r.passed);
console.log(`SQLite ${scalar('SELECT sqlite_version()')}, migrations: ${files.join(', ')}`);
for (const r of results) console.log(`${r.passed ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed, ${results.length} checks`);
process.exit(failed.length === 0 ? 0 : 1);
