-- Pi belongs to the existing Ghost. These rows bind Work to its one Pi task;
-- effect receipts are independent of transport commands and survive ACK loss.
CREATE TABLE IF NOT EXISTS lifetime_pi_executions (
 work_id TEXT PRIMARY KEY REFERENCES lifetime_work(id),
 execution_id TEXT NOT NULL UNIQUE,
 assignment_id TEXT NOT NULL,
 ghost_id TEXT NOT NULL,
 conversation_id TEXT NOT NULL,
 generation_task_id INTEGER NOT NULL CHECK(generation_task_id > 0),
 authority_epoch INTEGER NOT NULL,
 goal_revision INTEGER NOT NULL,
 computer_id TEXT NOT NULL,
 privacy TEXT NOT NULL,
 skills_json TEXT NOT NULL,
 input_artifacts_json TEXT NOT NULL,
 created_ms INTEGER NOT NULL,
 deadline_ms INTEGER NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('running','completed','unknown','cancelled'))
);
CREATE TABLE IF NOT EXISTS lifetime_pi_effects (
 execution_id TEXT NOT NULL REFERENCES lifetime_pi_executions(execution_id),
 task_id INTEGER NOT NULL CHECK(task_id > 0),
 call_id TEXT NOT NULL,
 input_digest TEXT NOT NULL,
 operation TEXT NOT NULL,
 arguments_json TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','complete','unknown')),
 response_json TEXT,
 PRIMARY KEY(execution_id,task_id,call_id)
);
