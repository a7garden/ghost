// Read-only weekly acceptance report for a Ghost state root.
// Usage: bun scripts/acceptance-report.ts [stateRoot]   (default: GHOST_ROOT or ~/Library/Application Support/Ghost)
import { Database } from "bun:sqlite";
import { join } from "node:path";

const root = process.argv[2] ?? process.env.GHOST_ROOT ?? join(process.env.HOME!, "Library/Application Support/Ghost");
const db = new Database(`file:${join(root, "ledger.db")}?mode=ro`, { readonly: true });

const table = (title: string, rows: Record<string, unknown>[]) => {
  console.log(`\n## ${title}`);
  if (rows.length) console.table(rows);
  else console.log("(none)");
};

// Roots only. "imported unfinished" rows come from the legacy import, not from real runs.
const roots = `works WHERE parent_id IS NULL AND COALESCE(reason, '') != 'imported unfinished'`;

table(
  "Root Work per week: owner-handed vs activity",
  db.query(`
    SELECT strftime('%Y-W%W', created_at / 1000, 'unixepoch') AS week,
           CASE WHEN activity_id IS NULL THEN 'owner' ELSE 'activity' END AS origin,
           COUNT(*) AS roots,
           SUM(state = 'done') AS done,
           SUM(state = 'failed') AS failed,
           SUM(state = 'cancelled') AS cancelled,
           SUM(state = 'done' AND revisions_used > 0) AS done_after_revision,
           ROUND(100.0 * SUM(state = 'done') / NULLIF(SUM(state IN ('done','failed')), 0), 0) AS done_pct_of_settled
    FROM ${roots} GROUP BY 1, 2 ORDER BY 1, 2`).all() as Record<string, unknown>[],
);

table(
  "Failure reasons (roots)",
  db.query(`SELECT substr(reason, 1, 60) AS reason, COUNT(*) AS n FROM ${roots} AND state = 'failed'
            GROUP BY 1 ORDER BY 2 DESC LIMIT 8`).all() as Record<string, unknown>[],
);

table(
  "Accepted roots by verdict source",
  db.query(`SELECT COALESCE(json_extract(verdict, '$.source'), verdict) AS source, COUNT(*) AS n
            FROM ${roots} AND state = 'done' GROUP BY 1`).all() as Record<string, unknown>[],
);

table(
  "Owner decisions by kind and outcome",
  db.query(`SELECT kind, state, COUNT(*) AS n FROM decisions GROUP BY 1, 2 ORDER BY 1, 2`).all() as Record<string, unknown>[],
);

table(
  "Child Work settled",
  db.query(`SELECT state, COUNT(*) AS n FROM works WHERE parent_id IS NOT NULL GROUP BY 1`).all() as Record<string, unknown>[],
);

table(
  "code_run trunk (coding_runs rows)",
  db.query(`SELECT COUNT(*) AS runs FROM coding_runs`).all() as Record<string, unknown>[],
);

table(
  "Latest root Work",
  db.query(`SELECT datetime(MAX(created_at) / 1000, 'unixepoch') AS latest FROM works WHERE parent_id IS NULL`).all() as Record<string, unknown>[],
);
