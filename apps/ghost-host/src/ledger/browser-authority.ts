import type { Database } from "bun:sqlite";

const CUTOVER = "browser:card-fill-cutover:1";

/** Data-only tool split, independent of schema versions on concurrent release lines. */
export function migrateBrowserAuthority(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT 1 FROM settings WHERE key=?").get(CUTOVER)) return;
    db.exec(`
      UPDATE ghosts SET tools = json_insert(tools, '$[#]', 'browser_fill_card')
        WHERE EXISTS (SELECT 1 FROM json_each(ghosts.tools) WHERE value = 'browser_fill_secret')
          AND NOT EXISTS (SELECT 1 FROM json_each(ghosts.tools) WHERE value = 'browser_fill_card');
      UPDATE works SET tool_scope = json_insert(tool_scope, '$[#]', 'browser_fill_card')
        WHERE tool_scope IS NOT NULL
          AND EXISTS (SELECT 1 FROM json_each(works.tool_scope) WHERE value = 'browser_fill_secret')
          AND NOT EXISTS (SELECT 1 FROM json_each(works.tool_scope) WHERE value = 'browser_fill_card');
      UPDATE activities SET data = json_insert(data, '$.tools[#]', 'browser_fill_card')
        WHERE EXISTS (SELECT 1 FROM json_each(activities.data, '$.tools') WHERE value = 'browser_fill_secret')
          AND NOT EXISTS (SELECT 1 FROM json_each(activities.data, '$.tools') WHERE value = 'browser_fill_card');
    `);
    // A later explicit revocation is final: reopening this ledger must not grant the tool again.
    db.query("INSERT INTO settings(key,value) VALUES(?,?)").run(CUTOVER, "true");
  })();
}
