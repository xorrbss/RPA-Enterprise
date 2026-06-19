import {
  assertArtifactStoreTopologyCompatibility,
  loadRunMode,
  type ArtifactStoreTopology,
} from "./env";

const TOPOLOGY_LABELS: Record<ArtifactStoreTopology, string> = {
  in_process: "in-process RUN_MODE=all",
  split_worker_lifecycle: "split worker/lifecycle processes",
};

function main(): void {
  let topology: ArtifactStoreTopology | undefined;
  try {
    topology = parseTopology(process.argv.slice(2));
    assertArtifactStoreTopologyCompatibility(topology);
    console.log(JSON.stringify({
      at: "artifact-store-topology-preflight",
      status: "pass",
      topology,
      label: TOPOLOGY_LABELS[topology],
    }));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(JSON.stringify({
      at: "artifact-store-topology-preflight",
      status: "fail",
      ...(topology !== undefined ? { topology, label: TOPOLOGY_LABELS[topology] } : {}),
      reason: message,
    }));
    process.exit(1);
  }
}

function parseTopology(args: readonly string[]): ArtifactStoreTopology {
  if (args.includes("--help")) {
    printUsage();
    process.exit(0);
  }

  let value: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--topology") {
      if (args[i + 1] === undefined || args[i + 1].startsWith("--")) {
        throw new Error("--topology requires a value");
      }
      value = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith("--topology=")) {
      value = arg.slice("--topology=".length);
      continue;
    }
    throw new Error(`unknown option ${JSON.stringify(arg)}`);
  }

  if (value === undefined) {
    const runMode = loadRunMode();
    if (runMode === "all") return "in_process";
    throw new Error("artifact-store topology preflight requires --topology for split worker/lifecycle deployments");
  }

  const normalized = value.toLowerCase().replace(/-/g, "_");
  if (normalized === "in_process" || normalized === "all") return "in_process";
  if (normalized === "split_worker_lifecycle" || normalized === "split") return "split_worker_lifecycle";
  throw new Error(
    `--topology must be one of in-process|split-worker-lifecycle, got ${JSON.stringify(value)}`,
  );
}

function printUsage(): void {
  console.log([
    "Usage: tsx src/config/artifact-store-topology-preflight.ts --topology <in-process|split-worker-lifecycle>",
    "",
    "Validates that D8-A16 FsObjectStore artifact producers and the artifact lifecycle worker share a compatible backing store.",
    "For split staging/prod deployments, run this in the deploy environment before starting worker processes.",
  ].join("\n"));
}

main();
