import { runFixtures, ALL_FIXTURES } from "./transitions.fixtures";

const failures = runFixtures();
console.log(`fixtures: ${ALL_FIXTURES.length} total, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("FAIL:", f.name, "—", f.reason);
  process.exit(1);
}
console.log("ALL PASS");
