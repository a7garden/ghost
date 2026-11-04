import { ProtocolError } from './contract.js';
const conflict = () => new ProtocolError('goal_assignment_route_conflict', 'This assignment was admitted with a different local route; use a fresh authorized assignment.', 'never');
function descriptor(value) {
  if (value === undefined || value === null) return { identity: null, maxOutputTokens: null };
  if (!/^[a-f0-9]{64}$/u.test(value.identity) || !Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 4096) throw conflict();
  return value;
}
export async function initializeLocalRoutePins(index) {
  await index.exec(`CREATE TABLE IF NOT EXISTS ghost_assignment_local_route_pins (
    assignment_id TEXT PRIMARY KEY, identity TEXT, max_output_tokens INTEGER
  )`);
}
export async function assertLocalRoutePin(index, assignmentId, config) {
  const route = descriptor(config);
  const pin = await index.get('SELECT identity, max_output_tokens FROM ghost_assignment_local_route_pins WHERE assignment_id = ?', assignmentId);
  if (!pin) {
    // Existing unpinned assignments retain only the historical default budget.
    // Inspection does not manufacture or migrate an immutable admission pin.
    if (route.identity !== null && route.maxOutputTokens !== 1024) throw conflict();
    return;
  }
  if (pin.identity !== route.identity || pin.max_output_tokens !== route.maxOutputTokens) throw conflict();
}
export async function admitLocalRoutePin(transaction, assignmentId, config) {
  const route = descriptor(config);
  const existing = await transaction.get('SELECT assignment_id FROM ghost_assignment_local_route_pins WHERE assignment_id = ?', assignmentId);
  if (existing) { await assertLocalRoutePin(transaction, assignmentId, config); return; }
  await transaction.run('INSERT INTO ghost_assignment_local_route_pins (assignment_id, identity, max_output_tokens) VALUES (?, ?, ?)', assignmentId, route.identity, route.maxOutputTokens);
}
