import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { MIGRATIONS } from "../src/ledger/schema.ts";
import { migrateBrowserAuthority } from "../src/ledger/browser-authority.ts";

test("separating card fills preserves old authority without granting disabled scopes or duplicating grants", () => {
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS.slice(0, 7)) db.exec(migration);
    const scopes = [
      { id: "enabled", before: ["browser_open", "browser_fill_secret"], after: ["browser_open", "browser_fill_secret", "browser_fill_card"] },
      { id: "disabled", before: ["browser_open"], after: ["browser_open"] },
      { id: "empty", before: [], after: [] },
      { id: "already", before: ["browser_fill_secret", "browser_fill_card"], after: ["browser_fill_secret", "browser_fill_card"] },
    ];
    for (const scope of scopes) {
      const tools = JSON.stringify(scope.before);
      db.query(`INSERT INTO ghosts (id,name,persona,look,is_default,state,direct_conversation_id,created_at,updated_at,tools)
        VALUES (?,?,'','{}',0,'active',?,1,1,?)`).run(scope.id, scope.id, `${scope.id}-direct`, tools);
      db.query(`INSERT INTO conversations (id,ghost_id,kind,title,created_at,last_activity_at)
        VALUES (?,?,'direct','Owner',1,1)`).run(`${scope.id}-direct`, scope.id);
      db.query(`INSERT INTO works (id,root_id,ghost_id,origin_conversation_id,title,brief,acceptance,state,revision,created_at,updated_at,tool_scope)
        VALUES (?,?,?,?,'Existing','Keep the scope','{}','running',1,1,1,?)`).run(scope.id, scope.id, scope.id, `${scope.id}-direct`, tools);
      db.query("INSERT INTO activities(id,data) VALUES(?,?)").run(scope.id, JSON.stringify({ id: scope.id, name: "Existing", tools: scope.before, revision: 4 }));
    }
    db.query(`INSERT INTO works (id,root_id,ghost_id,origin_conversation_id,title,brief,acceptance,state,revision,created_at,updated_at,tool_scope)
      VALUES ('unscoped','unscoped','enabled','enabled-direct','Unscoped','B','{}','running',1,1,1,NULL)`).run();
    migrateBrowserAuthority(db);
    migrateBrowserAuthority(db);
    for (const scope of scopes) {
      const ghost = db.query("SELECT tools FROM ghosts WHERE id=?").get(scope.id) as { tools: string };
      const work = db.query("SELECT tool_scope FROM works WHERE id=?").get(scope.id) as { tool_scope: string };
      const activity = db.query("SELECT data FROM activities WHERE id=?").get(scope.id) as { data: string };
      expect(JSON.parse(ghost.tools)).toEqual(scope.after);
      expect(JSON.parse(work.tool_scope)).toEqual(scope.after);
      expect(JSON.parse(activity.data)).toEqual({ id: scope.id, name: "Existing", tools: scope.after, revision: 4 });
    }
    expect(db.query("SELECT tool_scope FROM works WHERE id='unscoped'").get()).toEqual({ tool_scope: null });
    db.query("UPDATE ghosts SET tools=? WHERE id='enabled'").run('["browser_open","browser_fill_secret"]');
    db.query("UPDATE works SET tool_scope=? WHERE id='enabled'").run('["browser_fill_secret"]');
    db.query("UPDATE activities SET data=json_set(data,'$.tools',json(?)) WHERE id='enabled'").run('["browser_fill_secret"]');
    migrateBrowserAuthority(db);
    expect(db.query("SELECT tools FROM ghosts WHERE id='enabled'").get()).toEqual({ tools: '["browser_open","browser_fill_secret"]' });
    expect(db.query("SELECT tool_scope FROM works WHERE id='enabled'").get()).toEqual({ tool_scope: '["browser_fill_secret"]' });
    const revokedActivity = db.query("SELECT data FROM activities WHERE id='enabled'").get();
    if (!revokedActivity || typeof revokedActivity !== "object" || !("data" in revokedActivity) || typeof revokedActivity.data !== "string") throw new Error("missing activity fixture");
    expect(JSON.parse(revokedActivity.data).tools).toEqual(["browser_fill_secret"]);
  } finally { db.close(); }
});
