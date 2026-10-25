import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openAdmissionFixture, hostState, scope } from './selected-admission-fixture.mjs';

const root = process.argv[2], state = hostState();
const hold = setInterval(() => {}, 1000);
const fixture = await openAdmissionFixture(root, state, { committed: async (request, current) => {
  await writeFile(join(root, 'committed.json'), JSON.stringify({ request, effects: current.effects, receipts: [...current.receipts] }));
  process.stdout.write('committed\n');
  await new Promise(() => {});
} });
await fixture.admission.ensure(fixture.session, scope.turn_id);
clearInterval(hold);
await fixture.close();
