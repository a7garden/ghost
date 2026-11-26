import type { Database } from "bun:sqlite";

const CUTOVER = "goals:main-tools-cutover:1";

/**
 * The main Ghost is the entry point for goal proposals ("말하기" on the goals screen, autonomy wakes with no goals),
 * but a main created before goals existed holds a stored allow-list without `goal_list`/`goal_propose`. Grant them once.
 * Data-only and marker-guarded: a later explicit revocation by the owner is final.
 */
export function migrateMainGoalTools(db: Database): void {
  db.transaction(() => {
    if (db.query("SELECT 1 FROM settings WHERE key=?").get(CUTOVER)) return;
    for (const tool of ["goal_list", "goal_propose"]) {
      db.query(`UPDATE ghosts SET tools = json_insert(tools, '$[#]', ?)
        WHERE is_default = 1 AND NOT EXISTS (SELECT 1 FROM json_each(ghosts.tools) WHERE value = ?)`).run(tool, tool);
    }
    db.query("INSERT INTO settings(key,value) VALUES(?,?)").run(CUTOVER, "true");
  })();
}
