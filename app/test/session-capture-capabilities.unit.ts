import assert from "node:assert/strict";

import { runtimeCapabilitiesFromEnv, sessionCaptureServerModeFromEnv } from "../src/api/capabilities";
import { isLaunchingCaptureExpired } from "../src/api/sessions";

assert.equal(sessionCaptureServerModeFromEnv(undefined), "off");
assert.equal(sessionCaptureServerModeFromEnv(""), "off");
assert.equal(sessionCaptureServerModeFromEnv("prod"), "off");
assert.equal(sessionCaptureServerModeFromEnv("dev"), "dev");

assert.deepEqual(runtimeCapabilitiesFromEnv({ SESSION_CAPTURE_SERVER_MODE: "off" }), {
  session_capture: { server: { mode: "off", enabled: false } },
});
assert.deepEqual(runtimeCapabilitiesFromEnv({ SESSION_CAPTURE_SERVER_MODE: "dev" }), {
  session_capture: { server: { mode: "dev", enabled: true } },
});

const now = new Date("2026-07-02T12:00:00.000Z");
assert.equal(isLaunchingCaptureExpired(new Date("2026-07-02T11:50:01.000Z"), now), false);
assert.equal(isLaunchingCaptureExpired(new Date("2026-07-02T11:50:00.000Z"), now), true);
assert.equal(isLaunchingCaptureExpired(new Date("2026-07-02T11:49:59.000Z"), now), true);

console.log("PASS: session capture capabilities unit");
