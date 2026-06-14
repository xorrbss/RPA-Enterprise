import { runFixtures, ALL_FIXTURES } from "./transitions.fixtures";
import "./validators.fixtures";
import "./irel.fixtures";
import "./event-schema.fixtures";
import "./gateway.fixtures";
import "./runtime.fixtures";
import "./security.fixtures";
import "./control-plane.fixtures";

const failures = runFixtures();
console.log(`fixtures: ${ALL_FIXTURES.length} total, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("FAIL:", f.name, "--", f.reason);
  process.exit(1);
}
console.log("ALL PASS");
