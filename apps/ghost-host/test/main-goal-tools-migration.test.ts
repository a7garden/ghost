import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../src/ledger/schema.ts";
import { migrateMainGoalTools } from "../src/ledger/goal-authority.ts";

test("only the main Ghost gains the goal tools, once, and a later revocation stays final", () => {
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS.slice(0, 7)) db.exec(migration);
    const insert = (id: string, isDefault: number, tools: string[]) => {
      db.query(`INSERT INTO ghosts (id,name,persona,look,is_default,state,direct_conversation_id,created_at,updated_at,tools)
        VALUES (?,?,'','{}',?,'active',?,1,1,?)`).run(id, id, isDefault, `${id}-direct`, JSON.stringify(tools));
      db.query(`INSERT INTO conversations (id,ghost_id,kind,title,created_at,last_activity_at) VALUES (?,?,'direct','Owner',1,1)`).run(`${id}-direct`, id);
    };
    insert("main", 1, ["work_create", "goal_list"]);
    insert("other", 0, ["work_create"]);
    migrateMainGoalTools(db);
    migrateMainGoalTools(db);
    const tools = (id: string) => JSON.parse((db.query("SELECT tools FROM ghosts WHERE id=?").get(id) as { tools: string }).tools);
    expect(tools("main")).toEqual(["work_create", "goal_list", "goal_propose"]);
    expect(tools("other")).toEqual(["work_create"]);
    db.query("UPDATE ghosts SET tools=? WHERE id='main'").run('["work_create"]');
    migrateMainGoalTools(db);
    expect(tools("main")).toEqual(["work_create"]);
  } finally { db.close(); }
});
