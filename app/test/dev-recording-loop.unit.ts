import assert from "node:assert/strict";

import type { Pool } from "pg";

import { startRecordingLoop } from "../dev/recording-loop";
import type { BrowserRecordingLaunchInput, BrowserRecordingLaunchHandle } from "../src/browser-helper/browser-recording-helper";

const TENANT = "00000000-0000-0000-0000-0000000000d1";
const RECORDING = "94000000-0000-4000-8000-000000000001";
const START_URL = "https://portal.example.com/orders";

interface RecordingRow {
  readonly id: string;
  readonly start_url: string;
}

interface InsertedEvent {
  readonly id: unknown;
  readonly tenantId: unknown;
  readonly recordingId: unknown;
  readonly seq: unknown;
  readonly eventType: unknown;
  readonly selector: unknown;
  readonly label: unknown;
  readonly url: unknown;
  readonly valuePreview: unknown;
}

interface FakeState {
  readonly row: RecordingRow;
  readonly events: InsertedEvent[];
  readonly logs: string[];
  eventCountUpdates: number;
  releases: number;
}

class FakeClient {
  constructor(private readonly state: FakeState) {}

  async query<T = unknown>(text: string, params?: readonly unknown[]): Promise<{ rows: T[] }> {
    if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.startsWith("SELECT set_config")) {
      return { rows: [] };
    }

    if (text.includes("FROM browser_recording_sessions")) {
      return { rows: [this.state.row] as T[] };
    }

    if (text.includes("INSERT INTO browser_recording_events")) {
      assert.ok(params !== undefined, "insert should bind event params");
      this.state.events.push({
        id: params[0],
        tenantId: params[1],
        recordingId: params[2],
        seq: params[3],
        eventType: params[4],
        selector: params[5],
        label: params[6],
        url: params[7],
        valuePreview: params[8],
      });
      return { rows: [] };
    }

    if (text.includes("UPDATE browser_recording_sessions SET event_count")) {
      this.state.eventCountUpdates += 1;
      return { rows: [] };
    }

    throw new Error(`unexpected query: ${text}`);
  }

  release(): void {
    this.state.releases += 1;
  }
}

class FakePool {
  constructor(private readonly state: FakeState) {}

  async connect(): Promise<FakeClient> {
    return new FakeClient(this.state);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label: string, condition: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    if (condition()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

async function main(): Promise<void> {
  const state: FakeState = {
    row: { id: RECORDING, start_url: START_URL },
    events: [],
    logs: [],
    eventCountUpdates: 0,
    releases: 0,
  };
  const launches: Array<Pick<BrowserRecordingLaunchInput, "startUrl" | "chromePath">> = [];
  let closeCalled = false;
  let resolveClosed: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const handle: BrowserRecordingLaunchHandle = {
    async waitUntilClosed() {
      await closed;
    },
    async close() {
      closeCalled = true;
      resolveClosed?.();
    },
  };

  const loop = await startRecordingLoop(new FakePool(state) as unknown as Pool, TENANT, 5, {
    findChrome: () => "C:/fake/chrome.exe",
    newId: (() => {
      let n = 0;
      return () => `event-${(n += 1)}`;
    })(),
    log: (message) => state.logs.push(message),
    launchBrowser: async (input) => {
      launches.push({ startUrl: input.startUrl, chromePath: input.chromePath });
      await input.onNavigate(input.startUrl);
      await input.receive({ type: "click", selector: "button.approve", label: "Approve" });
      await input.receive({ type: "input", selector: "input[name='password']", name: "password", inputType: "password", value: "secret" });
      return handle;
    },
  });

  assert.notEqual(loop, null, "Chrome discovery should enable the recording loop");
  await waitFor("sanitized recording events", () => state.events.length === 2);
  await sleep(20);

  assert.deepEqual(launches, [{ startUrl: START_URL, chromePath: "C:/fake/chrome.exe" }], "recording session should launch one headful helper window");
  assert.deepEqual(
    state.events.map((event) => [event.seq, event.eventType, event.selector, event.url]),
    [
      [1, "navigate", null, START_URL],
      [2, "click", "button.approve", null],
    ],
    "recording loop should persist navigate/click events with stable seq",
  );
  assert.equal(state.eventCountUpdates, 2, "recording event_count should track inserted events");
  assert.equal(state.events.some((event) => String(event.selector).includes("password") || String(event.valuePreview).includes("secret")), false, "sensitive input should be dropped by shared sanitizer");
  assert.ok(state.releases >= 3, "tenant transactions should release fake clients");

  await loop?.stop();
  assert.equal(closeCalled, true, "stop should close any open recorder Chrome handles");

  const disabled = await startRecordingLoop(new FakePool(state) as unknown as Pool, TENANT, 5, {
    findChrome: () => null,
    log: (message) => state.logs.push(message),
    launchBrowser: async () => {
      throw new Error("should not launch without Chrome");
    },
  });
  assert.equal(disabled, null, "missing Chrome should disable the dev recording loop loudly");

  console.log("PASS: dev recording loop launches Chrome helper and stores sanitized events");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
