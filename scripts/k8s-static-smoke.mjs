#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const failures = [];

const baseResourceFiles = [
  "deploy/k8s/base/00-namespace.yaml",
  "deploy/k8s/base/01-serviceaccounts.yaml",
  "deploy/k8s/base/02-configmap.yaml",
  "deploy/k8s/base/03-secret.example.yaml",
  "deploy/k8s/base/10-migrate-job.yaml",
  "deploy/k8s/base/20-api.yaml",
  "deploy/k8s/base/21-worker.yaml",
  "deploy/k8s/base/22-lifecycle-worker.yaml",
  "deploy/k8s/base/30-policies.yaml",
  "deploy/k8s/base/31-api-hpa.yaml",
  "deploy/k8s/base/kustomization.yaml",
];

const baseOptionalFiles = [
  "deploy/k8s/base/32-egress-owner-allowlist.optional.yaml",
  "deploy/k8s/base/40-ingress.optional.yaml",
];

const baseFiles = [...baseResourceFiles, ...baseOptionalFiles];

const helmFiles = [
  "deploy/helm/rpa/Chart.yaml",
  "deploy/helm/rpa/values.yaml",
  "deploy/helm/rpa/templates/_helpers.tpl",
  "deploy/helm/rpa/templates/configmap.yaml",
  "deploy/helm/rpa/templates/serviceaccounts.yaml",
  "deploy/helm/rpa/templates/migrate-job.yaml",
  "deploy/helm/rpa/templates/api.yaml",
  "deploy/helm/rpa/templates/worker.yaml",
  "deploy/helm/rpa/templates/lifecycle-worker.yaml",
  "deploy/helm/rpa/templates/pdb.yaml",
  "deploy/helm/rpa/templates/hpa.yaml",
  "deploy/helm/rpa/templates/ingress.yaml",
  "deploy/helm/rpa/templates/networkpolicy.yaml",
  "deploy/helm/rpa/templates/NOTES.txt",
];

const base = Object.fromEntries(baseFiles.map((path) => [path, readRequired(path)]));
const helm = Object.fromEntries(helmFiles.map((path) => [path, readRequired(path)]));
const baseAll = Object.values(base).join("\n");
const helmAll = Object.values(helm).join("\n");
const values = helm["deploy/helm/rpa/values.yaml"];
const runLocalGates = readRequired("scripts/run-local-gates.mjs");
const codegenPackage = readRequired("codegen/package.json");

checkBaseYamlParse();
checkKustomizeBase();
checkBaseRuntimeContract();
checkHelmRuntimeContract();
checkSmokeWiring();

if (failures.length > 0) {
  console.error(`k8s static smoke: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(
  `k8s static smoke: ${baseResourceFiles.length} kustomize base files, ${baseOptionalFiles.length} optional base templates, and ${helmFiles.length} Helm chart files checked`,
);
console.log(
  "k8s static smoke coverage: non-root pods, split DB roles, external Graphile migrations, SecretRef-only credentials, S3 artifact stores, readiness/liveness probes, API HPA, topology/anti-affinity, fail-closed ingress and egress NetworkPolicy",
);

function checkBaseYamlParse() {
  const files = baseFiles.map((path) => join(ROOT, ...path.split("/")));
  const script = [
    "import sys",
    "from pathlib import Path",
    "try:",
    "    import yaml",
    "except ImportError:",
    "    print('PyYAML is required for Kubernetes manifest parsing', file=sys.stderr)",
    "    raise SystemExit(2)",
    "for name in sys.argv[1:]:",
    "    path = Path(name)",
    "    try:",
    "        docs = list(yaml.safe_load_all(path.read_text(encoding='utf-8')))",
    "    except yaml.YAMLError as exc:",
    "        print(f'{path}: YAML parse failed: {exc}', file=sys.stderr)",
    "        raise SystemExit(1)",
    "    if not docs or any(doc is None for doc in docs):",
    "        print(f'{path}: YAML document must not be empty', file=sys.stderr)",
    "        raise SystemExit(1)",
  ].join("\n");

  const result = runPython(["-c", script, ...files]);
  if (result.status !== 0) {
    failures.push(`kustomize base YAML parse failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

function checkKustomizeBase() {
  const kustomization = base["deploy/k8s/base/kustomization.yaml"];
  for (const file of baseResourceFiles.filter((path) => !path.endsWith("kustomization.yaml"))) {
    requireIn("kustomization resource list", kustomization, file.replace("deploy/k8s/base/", ""));
  }
  for (const file of baseOptionalFiles) {
    rejectRegex(
      `kustomization must not include optional owner-decision template ${file}`,
      kustomization,
      new RegExp(`\\b${escapeRegex(file.replace("deploy/k8s/base/", ""))}\\b`),
    );
  }

  const serviceAccounts = base["deploy/k8s/base/01-serviceaccounts.yaml"];
  for (const name of ["rpa-api", "rpa-worker", "rpa-lifecycle-worker", "rpa-migrate"]) {
    requireRegex(
      `base service account ${name} automount disabled`,
      serviceAccounts,
      new RegExp(`name:\\s*${escapeRegex(name)}[\\s\\S]*?automountServiceAccountToken:\\s*false`, "i"),
    );
  }
}

function checkBaseRuntimeContract() {
  const config = base["deploy/k8s/base/02-configmap.yaml"];
  const secretExample = base["deploy/k8s/base/03-secret.example.yaml"];
  const migrate = base["deploy/k8s/base/10-migrate-job.yaml"];
  const api = base["deploy/k8s/base/20-api.yaml"];
  const worker = base["deploy/k8s/base/21-worker.yaml"];
  const lifecycle = base["deploy/k8s/base/22-lifecycle-worker.yaml"];
  const policies = base["deploy/k8s/base/30-policies.yaml"];
  const hpa = base["deploy/k8s/base/31-api-hpa.yaml"];
  const ownerEgress = base["deploy/k8s/base/32-egress-owner-allowlist.optional.yaml"];
  const ingress = base["deploy/k8s/base/40-ingress.optional.yaml"];

  requireRegex("base namespace", base["deploy/k8s/base/00-namespace.yaml"], /name:\s*rpa-system/i);
  requireRegex("base graphile migrations external", config, /GRAPHILE_MIGRATIONS_MODE:\s*external/i);
  requireRegex("base runtime worker S3 artifact mode", config, /GATEWAY_ARTIFACT_STORE_MODE:\s*s3/i);
  requireRegex("base lifecycle S3 artifact mode", config, /ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE:\s*s3/i);
  requireRegex("base runtime object store SecretRef", config, /GATEWAY_ARTIFACT_OBJECT_STORE_REF:\s*rpa\/staging\/runtime-worker\/object_store\/artifacts/i);
  requireRegex("base lifecycle object store SecretRef", config, /ARTIFACT_OBJECT_STORE_REF:\s*rpa\/staging\/artifact-lifecycle\/object_store\/artifacts/i);
  rejectRegex("base must not use local filesystem artifact store", config, /local_fs/i);

  rejectRegex("base secret example must not embed PostgreSQL URLs", secretExample, /postgresql:\/\//i);
  rejectRegex("base secret example must not embed OpenAI API keys", secretExample, /sk-[A-Za-z0-9_-]{20,}/i);
  rejectRegex("base secret example must not embed obvious passwords", secretExample, /password\s*[:=]\s*[^ \n]*[A-Za-z0-9]{12,}/i);
  requireRegex("base secret example lifecycle DSN placeholder", secretExample, /MAINTENANCE_LIFECYCLE_DATABASE_URL:\s*REPLACE_WITH_SECRETSTORE_DSN/i);
  requireRegex("base secret example artifact lifecycle DSN placeholder", secretExample, /ARTIFACT_LIFECYCLE_DATABASE_URL:\s*REPLACE_WITH_SECRETSTORE_DSN/i);

  requireMigrationContract("base", migrate, /value:\s*rpa_migrator/i);
  requireDeploymentContract("base api", api, "api", /replicas:\s*2/i, [
    "JWT_HS256_SECRET",
    "VAULT_API_ROLE_ID",
    "VAULT_API_SECRET_ID",
    "VAULT_ADDR",
    "VAULT_MOUNT",
  ]);
  requireDeploymentContract("base worker", worker, "worker", /replicas:\s*1/i, [
    "MAINTENANCE_LIFECYCLE_DATABASE_URL",
    "CODEX_BASE_URL",
    "CODEX_API_KEY",
    "CODEX_MODEL",
    "VAULT_RUNTIME_WORKER_ROLE_ID",
    "VAULT_RUNTIME_WORKER_SECRET_ID",
    "VAULT_ADDR",
    "VAULT_MOUNT",
  ]);
  requireDeploymentContract("base lifecycle worker", lifecycle, "lifecycle-worker", /replicas:\s*1/i, [
    "ARTIFACT_LIFECYCLE_DATABASE_URL",
    "VAULT_ARTIFACT_LIFECYCLE_ROLE_ID",
    "VAULT_ARTIFACT_LIFECYCLE_SECRET_ID",
    "VAULT_ADDR",
    "VAULT_MOUNT",
  ]);
  requireTopologyContract("base api", api, "rpa-api", "api", true);
  requireTopologyContract("base worker", worker, "rpa-worker", "worker", false);
  requireTopologyContract("base lifecycle worker", lifecycle, "rpa-lifecycle-worker", "lifecycle-worker", false);

  requireRegex("base api HPA", hpa, /kind:\s*HorizontalPodAutoscaler[\s\S]*?name:\s*rpa-api/i);
  requireRegex("base api HPA targets deployment", hpa, /scaleTargetRef:[\s\S]*?kind:\s*Deployment[\s\S]*?name:\s*rpa-api/i);
  requireRegex("base api HPA min HA floor", hpa, /minReplicas:\s*2/i);
  requireRegex("base api HPA max cap", hpa, /maxReplicas:\s*6/i);
  requireRegex("base api HPA cpu metric", hpa, /name:\s*cpu[\s\S]*?averageUtilization:\s*70/i);
  requireRegex("base api HPA memory metric", hpa, /name:\s*memory[\s\S]*?averageUtilization:\s*80/i);
  requireRegex("base api PDB", policies, /kind:\s*PodDisruptionBudget[\s\S]*?name:\s*rpa-api[\s\S]*?minAvailable:\s*1/i);
  requireRegex("base api network policy", policies, /kind:\s*NetworkPolicy[\s\S]*?podSelector:[\s\S]*?app\.kubernetes\.io\/name:\s*rpa-api/i);
  requireRegex("base api ingress requires approved namespace label", policies, /namespaceSelector:[\s\S]*?matchLabels:[\s\S]*?rpa-ingress-approved:\s*"true"/i);
  rejectRegex("base api ingress must not allow every namespace", policies, /namespaceSelector:\s*\{\}/i);
  requireRegex("base default deny egress", policies, /kind:\s*NetworkPolicy[\s\S]*?name:\s*rpa-default-deny-egress[\s\S]*?policyTypes:[\s\S]*?-\s*Egress[\s\S]*?egress:\s*\[\]/i);
  requireRegex("base DNS egress only policy", policies, /name:\s*rpa-dns-egress[\s\S]*?kubernetes\.io\/metadata\.name:\s*kube-system[\s\S]*?k8s-app:\s*kube-dns[\s\S]*?port:\s*53/i);
  rejectRegex("base egress must not allow all IPv4", [policies, ownerEgress].join("\n"), /cidr:\s*["']?0\.0\.0\.0\/0["']?/i);
  rejectRegex("base egress must not allow all IPv6", [policies, ownerEgress].join("\n"), /cidr:\s*["']?::\/0["']?/i);
  requireRegex("base owner egress template keeps PostgreSQL CIDR blocked", ownerEgress, /OWNER_DECISION_REQUIRED_MANAGED_POSTGRES_CIDR/);
  requireRegex("base owner egress template keeps Vault CIDR blocked", ownerEgress, /OWNER_DECISION_REQUIRED_VAULT_CIDR/);
  requireRegex("base owner egress template keeps object store CIDR blocked", ownerEgress, /OWNER_DECISION_REQUIRED_OBJECT_STORE_CIDR/);
  requireRegex("base owner egress template keeps OTLP collector CIDR blocked", ownerEgress, /OWNER_DECISION_REQUIRED_OTLP_COLLECTOR_CIDR/);
  requireRegex("base owner egress template keeps LLM provider CIDR blocked", ownerEgress, /OWNER_DECISION_REQUIRED_LLM_PROVIDER_CIDR/);
  requireRegex("base optional ingress keeps host blocked", ingress, /kind:\s*Ingress[\s\S]*?OWNER_DECISION_REQUIRED_HOST/i);
  requireRegex("base optional ingress keeps TLS blocked", ingress, /secretName:\s*OWNER_DECISION_REQUIRED_TLS_SECRET/i);
  requireRegex("base optional ingress keeps class blocked", ingress, /ingressClassName:\s*OWNER_DECISION_REQUIRED_INGRESS_CLASS/i);
  rejectRegex("base runtime must not use postgres superuser", [api, worker, lifecycle].join("\n"), /\bPOSTGRES_USER\b|PGUSER:[\s\S]{0,80}postgres|postgresql:\/\/postgres/i);
}

function checkHelmRuntimeContract() {
  const chart = helm["deploy/helm/rpa/Chart.yaml"];
  const migrate = helm["deploy/helm/rpa/templates/migrate-job.yaml"];
  const api = helm["deploy/helm/rpa/templates/api.yaml"];
  const worker = helm["deploy/helm/rpa/templates/worker.yaml"];
  const lifecycle = helm["deploy/helm/rpa/templates/lifecycle-worker.yaml"];
  const pdb = helm["deploy/helm/rpa/templates/pdb.yaml"];
  const hpa = helm["deploy/helm/rpa/templates/hpa.yaml"];
  const ingress = helm["deploy/helm/rpa/templates/ingress.yaml"];
  const networkPolicy = helm["deploy/helm/rpa/templates/networkpolicy.yaml"];
  const serviceAccounts = helm["deploy/helm/rpa/templates/serviceaccounts.yaml"];
  const config = helm["deploy/helm/rpa/templates/configmap.yaml"];
  const notes = helm["deploy/helm/rpa/templates/NOTES.txt"];

  requireRegex("Helm chart v2", chart, /^apiVersion:\s*v2$/m);
  requireRegex("Helm default existing secret", values, /existingSecret:\s*rpa-runtime-secrets/i);
  requireRegex("Helm default migrator role", values, /migratorUser:\s*rpa_migrator/i);
  requireRegex("Helm default app role", values, /appUser:\s*rpa_app/i);
  requireRegex("Helm default graphile external", values, /graphileMigrationsMode:\s*external/i);
  requireRegex("Helm default artifact S3 mode", values, /artifactStore:[\s\S]*?mode:\s*s3/i);
  requireRegex("Helm default API HA floor", values, /api:[\s\S]*?replicas:\s*2/i);
  requireRegex("Helm default API autoscaling enabled", values, /api:[\s\S]*?autoscaling:[\s\S]*?enabled:\s*true/i);
  requireRegex("Helm default API HPA min HA floor", values, /autoscaling:[\s\S]*?minReplicas:\s*2/i);
  requireRegex("Helm default API HPA max cap", values, /autoscaling:[\s\S]*?maxReplicas:\s*6/i);
  requireRegex("Helm default API topology spread", values, /api:[\s\S]*?topologySpreadConstraints:[\s\S]*?topologyKey:\s*kubernetes\.io\/hostname/i);
  requireRegex("Helm default API hard anti-affinity", values, /api:[\s\S]*?requiredDuringSchedulingIgnoredDuringExecution/i);
  requireRegex("Helm default ingress disabled", values, /ingress:[\s\S]*?enabled:\s*false/i);
  requireRegex("Helm default ingress host empty", values, /ingress:[\s\S]*?host:\s*""/i);
  requireRegex("Helm default ingress TLS empty", values, /ingress:[\s\S]*?tls:[\s\S]*?secretName:\s*""/i);
  requireRegex("Helm default network policy enabled", values, /networkPolicy:[\s\S]*?enabled:\s*true/i);
  requireRegex("Helm default egress deny", values, /egress:[\s\S]*?defaultDeny:\s*true/i);
  requireRegex("Helm default owner egress allowlist empty", values, /ownerApprovedCidrs:\s*\[\]/i);
  requireRegex("Helm worker single replica until unique IDs are modeled", values, /worker:[\s\S]*?replicas:\s*1/i);
  requireRegex("Helm default worker topology spread", values, /worker:[\s\S]*?topologySpreadConstraints:[\s\S]*?topologyKey:\s*kubernetes\.io\/hostname/i);
  requireRegex("Helm default worker preferred anti-affinity", values, /worker:[\s\S]*?preferredDuringSchedulingIgnoredDuringExecution/i);
  requireRegex("Helm lifecycle single replica until unique IDs are modeled", values, /lifecycleWorker:[\s\S]*?replicas:\s*1/i);
  requireRegex("Helm default lifecycle topology spread", values, /lifecycleWorker:[\s\S]*?topologySpreadConstraints:[\s\S]*?topologyKey:\s*kubernetes\.io\/hostname/i);
  requireRegex("Helm default lifecycle preferred anti-affinity", values, /lifecycleWorker:[\s\S]*?preferredDuringSchedulingIgnoredDuringExecution/i);

  for (const name of ["rpa-api", "rpa-worker", "rpa-lifecycle-worker", "rpa-migrate"]) {
    requireRegex(
      `Helm service account ${name} automount disabled`,
      serviceAccounts,
      new RegExp(`name:\\s*${escapeRegex(name)}[\\s\\S]*?automountServiceAccountToken:\\s*false`, "i"),
    );
  }

  requireRegex("Helm graphile migrations external config", config, /GRAPHILE_MIGRATIONS_MODE:\s*\{\{\s*\.Values\.runtime\.graphileMigrationsMode\s*\|\s*quote\s*\}\}/i);
  requireRegex("Helm runtime object store SecretRef", config, /GATEWAY_ARTIFACT_OBJECT_STORE_REF:\s*\{\{\s*\.Values\.artifactStore\.gatewaySecretRef\s*\|\s*quote\s*\}\}/i);
  requireRegex("Helm lifecycle object store SecretRef", config, /ARTIFACT_OBJECT_STORE_REF:\s*\{\{\s*\.Values\.artifactStore\.lifecycleSecretRef\s*\|\s*quote\s*\}\}/i);

  requireMigrationContract("Helm", migrate, /\.Values\.database\.migratorUser/i);
  requireDeploymentContract("Helm api", api, "api", /\.Values\.api\.replicas/i, [
    "JWT_HS256_SECRET",
    "VAULT_API_ROLE_ID",
    "VAULT_API_SECRET_ID",
    "VAULT_ADDR",
    "VAULT_MOUNT",
  ]);
  requireDeploymentContract("Helm worker", worker, "worker", /\.Values\.worker\.replicas/i, [
    "MAINTENANCE_LIFECYCLE_DATABASE_URL",
    "CODEX_BASE_URL",
    "CODEX_API_KEY",
    "CODEX_MODEL",
    "VAULT_RUNTIME_WORKER_ROLE_ID",
    "VAULT_RUNTIME_WORKER_SECRET_ID",
    "VAULT_ADDR",
    "VAULT_MOUNT",
  ]);
  requireDeploymentContract("Helm lifecycle worker", lifecycle, "lifecycle-worker", /\.Values\.lifecycleWorker\.replicas/i, [
    "ARTIFACT_LIFECYCLE_DATABASE_URL",
    "VAULT_ARTIFACT_LIFECYCLE_ROLE_ID",
    "VAULT_ARTIFACT_LIFECYCLE_SECRET_ID",
    "VAULT_ADDR",
    "VAULT_MOUNT",
  ]);
  requireTopologyContract("Helm api", api, "rpa-api", "api", true);
  requireTopologyContract("Helm worker", worker, "rpa-worker", "worker", false);
  requireTopologyContract("Helm lifecycle worker", lifecycle, "rpa-lifecycle-worker", "lifecycle-worker", false);

  requireRegex("Helm api HPA template", hpa, /\.Values\.api\.autoscaling\.enabled[\s\S]*?kind:\s*HorizontalPodAutoscaler/i);
  requireRegex("Helm api HPA min values", hpa, /\.Values\.api\.autoscaling\.minReplicas/i);
  requireRegex("Helm api HPA max values", hpa, /\.Values\.api\.autoscaling\.maxReplicas/i);
  requireRegex("Helm ingress is gated", ingress, /if\s+\.Values\.ingress\.enabled/i);
  requireRegex("Helm ingress requires owner decisions", ingress, /fail\s+"ingress\.enabled requires owner-approved ingress\.className, ingress\.host, and ingress\.tls\.secretName"/i);
  requireRegex("Helm ingress renders TLS only from values", ingress, /\.Values\.ingress\.tls\.secretName/i);
  requireRegex("Helm network policy api ingress", networkPolicy, /kind:\s*NetworkPolicy[\s\S]*?name:\s*rpa-api-ingress[\s\S]*?\.Values\.networkPolicy\.apiIngress\.ingressNamespaceLabel/i);
  requireRegex("Helm network policy egress default deny", networkPolicy, /name:\s*rpa-default-deny-egress[\s\S]*?egress:\s*\[\]/i);
  requireRegex("Helm network policy DNS egress", networkPolicy, /name:\s*rpa-dns-egress[\s\S]*?\.Values\.networkPolicy\.egress\.dnsNamespaceLabel[\s\S]*?port:\s*53/i);
  requireRegex("Helm network policy owner CIDRs", networkPolicy, /\.Values\.networkPolicy\.egress\.ownerApprovedCidrs/i);
  requireRegex("Helm network policy rejects all IPv4 egress", networkPolicy, /eq\s+\$cidr\s+"0\.0\.0\.0\/0"/i);
  requireRegex("Helm network policy rejects all IPv6 egress", networkPolicy, /eq\s+\$cidr\s+"::\/0"/i);
  requireRegex("Helm api PDB", pdb, /kind:\s*PodDisruptionBudget[\s\S]*?name:\s*rpa-api[\s\S]*?minAvailable:\s*1/i);
  requireRegex("Helm notes mention out-of-band DB roles", notes, /roles\.sql/i);
  requireRegex("Helm notes mention existing Secret", notes, /rpa-runtime-secrets/i);
  requireRegex("Helm notes mention ingress owner decisions", notes, /ingress\.enabled=false[\s\S]*className[\s\S]*TLS secret/i);
  requireRegex("Helm notes mention egress owner decisions", notes, /Default egress is deny-all[\s\S]*ownerApprovedCidrs/i);
  rejectRegex("Helm templates must not render repository secrets", helmAll, /kind:\s*Secret|stringData:/i);
  rejectRegex("Helm runtime must not use postgres superuser", [api, worker, lifecycle].join("\n"), /\bPOSTGRES_USER\b|PGUSER:[\s\S]{0,80}postgres|postgresql:\/\/postgres/i);
}

function checkSmokeWiring() {
  requireRegex("codegen k8s smoke command", codegenPackage, /"k8s:static-smoke":\s*"node \.\.\/scripts\/k8s-static-smoke\.mjs"/);
  requireRegex("local gates include k8s smoke", runLocalGates, /"Kubernetes packaging static smoke",\s*"node",\s*\["scripts\/k8s-static-smoke\.mjs"\]/);
}

function requireMigrationContract(label, source, rolePattern) {
  requireRegex(`${label} migration command`, source, /command:\s*\["node",\s*"scripts\/db-migrate\.mjs",\s*"--baseline-existing",\s*"--graphile-worker",\s*"--smoke",\s*"--require-non-bypass"\]/i);
  requireRegex(`${label} migration uses migrator role`, source, rolePattern);
  requireRegex(`${label} migration automount disabled`, source, /automountServiceAccountToken:\s*false/i);
  requireRegex(`${label} migration non-root`, source, /runAsNonRoot:\s*true/i);
  requireRegex(`${label} migration no privilege escalation`, source, /allowPrivilegeEscalation:\s*false/i);
}

function requireDeploymentContract(label, source, runMode, replicasPattern, secretNames) {
  requireRegex(`${label} replicas`, source, replicasPattern);
  requireRegex(`${label} run mode`, source, new RegExp(`name:\\s*RUN_MODE[\\s\\S]*?value:\\s*${escapeRegex(runMode)}`, "i"));
  requireRegex(`${label} app DB role`, source, /name:\s*PGUSER[\s\S]*?(value:\s*rpa_app|\.Values\.database\.appUser)/i);
  requireRegex(`${label} automount disabled`, source, /automountServiceAccountToken:\s*false/i);
  requireRegex(`${label} non-root`, source, /runAsNonRoot:\s*true/i);
  requireRegex(`${label} no privilege escalation`, source, /allowPrivilegeEscalation:\s*false/i);
  requireRegex(`${label} health port`, source, /name:\s*health[\s\S]*?containerPort:\s*8081/i);
  requireRegex(`${label} readiness probe`, source, /readinessProbe:[\s\S]*?path:\s*\/readyz[\s\S]*?port:\s*health/i);
  requireRegex(`${label} liveness probe`, source, /livenessProbe:[\s\S]*?path:\s*\/livez[\s\S]*?port:\s*health/i);
  for (const secretName of secretNames) {
    requireRegex(`${label} SecretRef ${secretName}`, source, new RegExp(`name:\\s*${escapeRegex(secretName)}[\\s\\S]*?secretKeyRef:`, "i"));
  }
}

function requireTopologyContract(label, source, _name, _component, requiresHardAntiAffinity) {
  requireRegex(`${label} topology spread`, source, /topologySpreadConstraints/i);
  requireRegex(`${label} hostname topology key`, source, /topologyKey:\s*kubernetes\.io\/hostname|\.Values\.[A-Za-z.]+\.topologySpreadConstraints/i);
  requireRegex(`${label} pod anti-affinity`, source, /podAntiAffinity|\.Values\.[A-Za-z.]+\.affinity/i);
  if (requiresHardAntiAffinity) {
    requireRegex(
      `${label} hard anti-affinity`,
      source,
      /requiredDuringSchedulingIgnoredDuringExecution|\.Values\.api\.affinity/i,
    );
    requireRegex(`${label} fail-closed hostname scheduling`, source, /whenUnsatisfiable:\s*DoNotSchedule|\.Values\.api\.topologySpreadConstraints/i);
  } else {
    requireRegex(
      `${label} preferred anti-affinity`,
      source,
      /preferredDuringSchedulingIgnoredDuringExecution|\.Values\.(worker|lifecycleWorker)\.affinity/i,
    );
  }
}

function readRequired(path) {
  const absolute = join(ROOT, ...path.split("/"));
  if (!existsSync(absolute)) {
    failures.push(`${path}: missing file`);
    return "";
  }
  return readFileSync(absolute, "utf8");
}

function runPython(args) {
  const candidates = process.platform === "win32" ? ["python"] : ["python3", "python"];
  for (const command of candidates) {
    const result = spawnSync(command, args, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.error?.code === "ENOENT") continue;
    return result;
  }
  return { status: 2, stdout: "", stderr: "python is not available on PATH" };
}

function requireIn(label, source, needle) {
  if (!source.includes(needle)) failures.push(`${label}: missing ${JSON.stringify(needle)}`);
}

function requireRegex(label, source, pattern) {
  if (!pattern.test(source)) failures.push(`${label}: missing ${pattern}`);
}

function rejectRegex(label, source, pattern) {
  if (pattern.test(source)) failures.push(`${label}: forbidden ${pattern}`);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
