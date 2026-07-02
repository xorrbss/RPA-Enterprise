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
  "deploy/k8s/base/23-console.yaml",
  "deploy/k8s/base/30-policies.yaml",
  "deploy/k8s/base/31-api-hpa.yaml",
  "deploy/k8s/base/kustomization.yaml",
];

const baseOptionalFiles = [
  "deploy/k8s/base/32-egress-owner-allowlist.optional.yaml",
  "deploy/k8s/base/40-ingress.optional.yaml",
];

const baseFiles = [...baseResourceFiles, ...baseOptionalFiles];

const k8sOverlayFiles = [
  "deploy/k8s/overlays/staging-sample/kustomization.yaml",
];

const ownerDecisionNoteFiles = [
  "deploy/k8s/overlays/staging-sample/owner-decisions.txt",
  "deploy/helm/rpa/OWNER_DECISIONS.txt",
];

const helmFiles = [
  "deploy/helm/rpa/Chart.yaml",
  "deploy/helm/rpa/values.yaml",
  "deploy/helm/rpa/values.release.example.yaml",
  "deploy/helm/rpa/templates/_helpers.tpl",
  "deploy/helm/rpa/templates/configmap.yaml",
  "deploy/helm/rpa/templates/serviceaccounts.yaml",
  "deploy/helm/rpa/templates/migrate-job.yaml",
  "deploy/helm/rpa/templates/api.yaml",
  "deploy/helm/rpa/templates/console.yaml",
  "deploy/helm/rpa/templates/worker.yaml",
  "deploy/helm/rpa/templates/lifecycle-worker.yaml",
  "deploy/helm/rpa/templates/pdb.yaml",
  "deploy/helm/rpa/templates/hpa.yaml",
  "deploy/helm/rpa/templates/ingress.yaml",
  "deploy/helm/rpa/templates/networkpolicy.yaml",
  "deploy/helm/rpa/templates/NOTES.txt",
];

const docFiles = [
  "deploy/k8s/README.md",
  "docs/deploy/controlled-prod-packaging.md",
  "docs/staging-deploy-runbook.md",
];

const deploymentFiles = [
  "Dockerfile",
  "compose.yaml",
  "deploy/docker.env.example",
  "deploy/nginx/console.conf.template",
];

const deployment = Object.fromEntries(deploymentFiles.map((path) => [path, readRequired(path)]));
const base = Object.fromEntries(baseFiles.map((path) => [path, readRequired(path)]));
const overlays = Object.fromEntries(k8sOverlayFiles.map((path) => [path, readRequired(path)]));
const ownerDecisionNotes = Object.fromEntries(ownerDecisionNoteFiles.map((path) => [path, readRequired(path)]));
const helm = Object.fromEntries(helmFiles.map((path) => [path, readRequired(path)]));
const docs = Object.fromEntries(docFiles.map((path) => [path, readRequired(path)]));
const baseAll = Object.values(base).join("\n");
const overlayAll = Object.values(overlays).join("\n");
const ownerDecisionAll = Object.values(ownerDecisionNotes).join("\n");
const helmAll = Object.values(helm).join("\n");
const values = helm["deploy/helm/rpa/values.yaml"];
const releaseValues = helm["deploy/helm/rpa/values.release.example.yaml"];
const runLocalGates = readRequired("scripts/run-local-gates.mjs");
const codegenPackage = readRequired("codegen/package.json");

checkConsoleDockerComposeContract();
checkKubernetesYamlParse();
checkReleasePlaceholderBoundaries();
checkKustomizeBase();
checkBaseRuntimeContract();
checkK8sStagingSampleOverlay();
checkHelmRuntimeContract();
checkHelmReleaseValues();
checkOwnerDecisionNotes();
checkPackagingDocs();
checkSmokeWiring();

if (failures.length > 0) {
  console.error(`k8s static smoke: ${failures.length} failed`);
  for (const failure of failures) console.error(`FAIL: ${failure}`);
  process.exit(1);
}

console.log(
  `k8s static smoke: ${baseResourceFiles.length} kustomize base files, ${baseOptionalFiles.length} optional base templates, ${k8sOverlayFiles.length} sample overlay, ${ownerDecisionNoteFiles.length} owner-decision note files, and ${helmFiles.length} Helm chart files checked`,
);
console.log(
  "k8s static smoke coverage: non-root pods, split DB roles, console nginx same-origin proxy, external Graphile migrations, SecretRef-only credentials, S3 artifact stores, readiness/liveness probes, API HPA, topology/anti-affinity, fail-closed ingress and egress NetworkPolicy",
);

function checkConsoleDockerComposeContract() {
  const dockerfile = deployment["Dockerfile"];
  const compose = deployment["compose.yaml"];
  const dockerEnv = deployment["deploy/docker.env.example"];
  const nginx = deployment["deploy/nginx/console.conf.template"];

  requireRegex("Dockerfile has web dependency stage", dockerfile, /FROM node:\$\{NODE_VERSION\} AS web-deps/i);
  requireRegex("Dockerfile installs web with npm ci", dockerfile, /npm --prefix web ci/i);
  requireRegex("Dockerfile has web build stage", dockerfile, /FROM web-deps AS web-build/i);
  requireRegex("Dockerfile exposes VITE_API_BASE_URL build arg", dockerfile, /ARG VITE_API_BASE_URL=\/api/i);
  requireRegex("Dockerfile exposes VITE_OIDC_AUTH_URL build arg", dockerfile, /ARG VITE_OIDC_AUTH_URL=/i);
  requireRegex("Dockerfile runs web build", dockerfile, /npm --prefix web run build/i);
  requireRegex("Dockerfile has nginx console runtime target", dockerfile, /FROM nginxinc\/nginx-unprivileged:1\.27-alpine AS console-runtime/i);
  requireRegex("Dockerfile copies nginx console template", dockerfile, /deploy\/nginx\/console\.conf\.template/i);
  requireRegex("Dockerfile copies web dist into nginx root", dockerfile, /COPY --from=web-build \/workspace\/web\/dist \/usr\/share\/nginx\/html/i);

  const web = serviceBlock(compose, "web");
  requireRegex("compose web service exists", compose, /\n  web:\n/i);
  requireRegex("compose web builds console runtime target", web, /target:\s+console-runtime/i);
  requireRegex("compose web passes VITE_API_BASE_URL build arg", web, /VITE_API_BASE_URL:\s+\$\{VITE_API_BASE_URL:-\/api\}/i);
  requireRegex("compose web passes VITE_OIDC_AUTH_URL build arg", web, /VITE_OIDC_AUTH_URL:\s+\$\{VITE_OIDC_AUTH_URL:-\}/i);
  requireRegex("compose web depends on healthy api", web, /api:[\s\S]*?condition:\s+service_healthy/i);
  requireRegex("compose web exposes console port", web, /\$\{RPA_CONSOLE_PORT:-8088\}:8080/i);
  requireRegex("compose web points nginx at api service", web, /RPA_API_UPSTREAM:\s+http:\/\/api:8080/i);

  requireRegex("docker env documents console port", dockerEnv, /^RPA_CONSOLE_PORT=8088$/m);
  requireRegex("docker env defaults console API base to /api", dockerEnv, /^VITE_API_BASE_URL=\/api$/m);
  requireRegex("docker env includes OIDC auth URL setting", dockerEnv, /^VITE_OIDC_AUTH_URL=$/m);

  requireRegex("nginx listens on unprivileged port", nginx, /listen\s+8080;/i);
  requireRegex("nginx health endpoint", nginx, /location = \/healthz[\s\S]*?default_type text\/plain;[\s\S]*?return 200 "ok\\n";/i);
  requireRegex("nginx handles /api prefix", nginx, /location \/api\//i);
  requireRegex("nginx strips /api before proxying", nginx, /rewrite \^\/api\/\(\.\*\)\$ \/\$1 break;/i);
  requireRegex("nginx proxy uses API upstream env", nginx, /proxy_pass \${RPA_API_UPSTREAM};/i);
  requireRegex("nginx has SPA fallback", nginx, /try_files \$uri \$uri\/ \/index\.html;/i);
  rejectRegex("nginx must not expose a browser /v1 proxy", nginx, /location\s+(=|~|\^~)?\s*\/v1\b/i);
}

function checkKubernetesYamlParse() {
  const files = [...baseFiles, ...k8sOverlayFiles, "deploy/helm/rpa/values.release.example.yaml"].map((path) =>
    join(ROOT, ...path.split("/")),
  );
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
    failures.push(`Kubernetes/sample YAML parse failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
}

function checkReleasePlaceholderBoundaries() {
  const replaceMeAllowedFiles = new Set([
    "deploy/k8s/base/10-migrate-job.yaml",
    "deploy/k8s/base/20-api.yaml",
    "deploy/k8s/base/21-worker.yaml",
    "deploy/k8s/base/22-lifecycle-worker.yaml",
    "deploy/k8s/base/23-console.yaml",
  ]);
  for (const [path, source] of Object.entries({ ...base, ...overlays, ...helm })) {
    if (!source.includes("replace-me")) continue;
    if (replaceMeAllowedFiles.has(path)) continue;
    failures.push(`${path}: image placeholder replace-me is allowed only in fail-closed base workload templates`);
  }
  for (const path of replaceMeAllowedFiles) {
    const imageName = path.endsWith("23-console.yaml") ? "rpa-console" : "rpa-runtime";
    requireRegex(`${path} keeps fail-closed base image placeholder`, base[path], new RegExp(`ghcr\\.io\\/example\\/${imageName}:replace-me`));
  }
  rejectRegex("sample overlay must not contain replace-me", overlayAll, /replace-me/i);
  rejectRegex("Helm release example values must not contain replace-me", releaseValues, /replace-me/i);
  rejectRegex("Helm default values must not contain replace-me", values, /replace-me/i);
}

function checkKustomizeBase() {
  const kustomization = base["deploy/k8s/base/kustomization.yaml"];
  requireRegex("base kustomization declares fail-closed template boundary", kustomization, /Fail-closed template only/i);
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
  for (const name of ["rpa-api", "rpa-worker", "rpa-lifecycle-worker", "rpa-console", "rpa-migrate"]) {
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
  const console = base["deploy/k8s/base/23-console.yaml"];
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
  requireConsoleDeploymentContract("base console", console, /replicas:\s*2/i);
  requireTopologyContract("base api", api, "rpa-api", "api", true);
  requireTopologyContract("base worker", worker, "rpa-worker", "worker", false);
  requireTopologyContract("base lifecycle worker", lifecycle, "rpa-lifecycle-worker", "lifecycle-worker", false);
  requireTopologyContract("base console", console, "rpa-console", "console", false);

  requireRegex("base api HPA", hpa, /kind:\s*HorizontalPodAutoscaler[\s\S]*?name:\s*rpa-api/i);
  requireRegex("base api HPA targets deployment", hpa, /scaleTargetRef:[\s\S]*?kind:\s*Deployment[\s\S]*?name:\s*rpa-api/i);
  requireRegex("base api HPA min HA floor", hpa, /minReplicas:\s*2/i);
  requireRegex("base api HPA max cap", hpa, /maxReplicas:\s*6/i);
  requireRegex("base api HPA cpu metric", hpa, /name:\s*cpu[\s\S]*?averageUtilization:\s*70/i);
  requireRegex("base api HPA memory metric", hpa, /name:\s*memory[\s\S]*?averageUtilization:\s*80/i);
  requireRegex("base api PDB", policies, /kind:\s*PodDisruptionBudget[\s\S]*?name:\s*rpa-api[\s\S]*?minAvailable:\s*1/i);
  requireRegex("base api network policy", policies, /kind:\s*NetworkPolicy[\s\S]*?podSelector:[\s\S]*?app\.kubernetes\.io\/name:\s*rpa-api/i);
  requireRegex("base api allows console ingress", policies, /name:\s*rpa-api-ingress[\s\S]*?app\.kubernetes\.io\/name:\s*rpa-console[\s\S]*?app\.kubernetes\.io\/component:\s*console/i);
  requireRegex("base api ingress requires approved namespace label", policies, /namespaceSelector:[\s\S]*?matchLabels:[\s\S]*?rpa-ingress-approved:\s*"true"/i);
  requireRegex("base console ingress policy", policies, /kind:\s*NetworkPolicy[\s\S]*?name:\s*rpa-console-ingress[\s\S]*?app\.kubernetes\.io\/name:\s*rpa-console/i);
  requireRegex("base console egress to api policy", policies, /kind:\s*NetworkPolicy[\s\S]*?name:\s*rpa-console-to-api-egress[\s\S]*?app\.kubernetes\.io\/name:\s*rpa-api[\s\S]*?port:\s*8080/i);
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
  requireRegex("base optional ingress targets console", ingress, /kind:\s*Ingress[\s\S]*?name:\s*rpa-console[\s\S]*?service:[\s\S]*?name:\s*rpa-console/i);
  requireRegex("base optional ingress keeps host blocked", ingress, /kind:\s*Ingress[\s\S]*?OWNER_DECISION_REQUIRED_HOST/i);
  requireRegex("base optional ingress keeps TLS blocked", ingress, /secretName:\s*OWNER_DECISION_REQUIRED_TLS_SECRET/i);
  requireRegex("base optional ingress keeps class blocked", ingress, /ingressClassName:\s*OWNER_DECISION_REQUIRED_INGRESS_CLASS/i);
  rejectRegex("base runtime must not use postgres superuser", [api, worker, lifecycle].join("\n"), /\bPOSTGRES_USER\b|PGUSER:[\s\S]{0,80}postgres|postgresql:\/\/postgres/i);
}

function checkK8sStagingSampleOverlay() {
  const overlay = overlays["deploy/k8s/overlays/staging-sample/kustomization.yaml"];

  requireRegex("staging sample overlay points at base", overlay, /resources:[\s\S]*-\s*\.\.\/\.\.\/base/i);
  requireRegex(
    "staging sample overlay includes owner egress optional template",
    overlay,
    /resources:[\s\S]*32-egress-owner-allowlist\.optional\.yaml/i,
  );
  requireRegex("staging sample overlay sets staging namespace", overlay, /namespace:\s*rpa-staging/i);
  requireRegex("staging sample overlay is marked non-release", overlay, /rpa\.example\.com\/release-artifact:\s*"false"/i);
  requireRegex("staging sample overlay replaces base image repository", overlay, /newName:\s*registry\.owner-approved\.invalid\/rpa-runtime/i);
  requireRegex("staging sample overlay uses immutable image digest", overlay, /digest:\s*sha256:[a-f0-9]{64}/i);
  requireRegex("staging sample overlay replaces console image repository", overlay, /newName:\s*registry\.owner-approved\.invalid\/rpa-console/i);
  rejectRegex("staging sample overlay must not carry unresolved owner placeholders", overlay, /OWNER_DECISION_REQUIRED_/);
  for (const cidr of ["192.0.2.10/32", "192.0.2.20/32", "198.51.100.10/32", "198.51.100.20/32", "203.0.113.10/32"]) {
    requireIn("staging sample overlay documentation CIDR", overlay, cidr);
  }
  rejectRegex("staging sample overlay must not allow all IPv4", overlay, /0\.0\.0\.0\/0/);
  rejectRegex("staging sample overlay must not allow all IPv6", overlay, /::\/0/);
}

function checkHelmRuntimeContract() {
  const chart = helm["deploy/helm/rpa/Chart.yaml"];
  const helpers = helm["deploy/helm/rpa/templates/_helpers.tpl"];
  const migrate = helm["deploy/helm/rpa/templates/migrate-job.yaml"];
  const api = helm["deploy/helm/rpa/templates/api.yaml"];
  const console = helm["deploy/helm/rpa/templates/console.yaml"];
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
  requireRegex("Helm default image repository is empty", values, /image:[\s\S]*?repository:\s*""/i);
  requireRegex("Helm default image tag is empty", values, /image:[\s\S]*?tag:\s*""/i);
  requireRegex("Helm default image digest is empty", values, /image:[\s\S]*?digest:\s*""/i);
  requireRegex("Helm default console enabled", values, /console:[\s\S]*?enabled:\s*true/i);
  requireRegex("Helm default console image repository is empty", values, /console:[\s\S]*?image:[\s\S]*?repository:\s*""/i);
  requireRegex("Helm default console API upstream", values, /apiUpstream:\s*http:\/\/rpa-api:8080/i);
  requireRegex("Helm default console topology spread", values, /console:[\s\S]*?topologySpreadConstraints:[\s\S]*?topologyKey:\s*kubernetes\.io\/hostname/i);
  requireRegex("Helm default console preferred anti-affinity", values, /console:[\s\S]*?preferredDuringSchedulingIgnoredDuringExecution/i);
  requireRegex("Helm image helper requires repository", helpers, /image\.repository is required/i);
  requireRegex("Helm image helper renders digest reference", helpers, /printf\s+"%s@%s"/i);
  requireRegex("Helm image helper validates sha256 digest", helpers, /regexMatch\s+"\^sha256:\[a-f0-9\]\{64\}\$"/i);
  requireRegex("Helm image helper rejects latest tag", helpers, /image\.tag must not be latest/i);
  requireRegex("Helm image helper rejects replace-me-like tags", helpers, /\^replace\.\?me\$/i);
  requireRegex("Helm console image helper requires repository", helpers, /console\.image\.repository is required/i);
  requireRegex("Helm console image helper validates sha256 digest", helpers, /console\.image\.digest must be an immutable sha256 digest/i);
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

  for (const name of ["rpa-api", "rpa-worker", "rpa-lifecycle-worker", "rpa-console", "rpa-migrate"]) {
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
  requireConsoleDeploymentContract("Helm console", console, /\.Values\.console\.replicas/i);
  requireTopologyContract("Helm api", api, "rpa-api", "api", true);
  requireTopologyContract("Helm worker", worker, "rpa-worker", "worker", false);
  requireTopologyContract("Helm lifecycle worker", lifecycle, "rpa-lifecycle-worker", "lifecycle-worker", false);
  requireTopologyContract("Helm console", console, "rpa-console", "console", false);

  requireRegex("Helm api HPA template", hpa, /\.Values\.api\.autoscaling\.enabled[\s\S]*?kind:\s*HorizontalPodAutoscaler/i);
  requireRegex("Helm api HPA min values", hpa, /\.Values\.api\.autoscaling\.minReplicas/i);
  requireRegex("Helm api HPA max values", hpa, /\.Values\.api\.autoscaling\.maxReplicas/i);
  requireRegex("Helm ingress is gated", ingress, /if\s+\.Values\.ingress\.enabled/i);
  requireRegex("Helm ingress requires owner decisions", ingress, /fail\s+"ingress\.enabled requires owner-approved ingress\.className, ingress\.host, and ingress\.tls\.secretName"/i);
  requireRegex("Helm ingress renders TLS only from values", ingress, /\.Values\.ingress\.tls\.secretName/i);
  requireRegex("Helm ingress targets console service", ingress, /service:[\s\S]*?name:\s*rpa-console/i);
  requireRegex("Helm network policy api ingress", networkPolicy, /kind:\s*NetworkPolicy[\s\S]*?name:\s*rpa-api-ingress[\s\S]*?\.Values\.networkPolicy\.apiIngress\.ingressNamespaceLabel/i);
  requireRegex("Helm network policy api allows console", networkPolicy, /name:\s*rpa-api-ingress[\s\S]*?app\.kubernetes\.io\/name:\s*rpa-console[\s\S]*?app\.kubernetes\.io\/component:\s*console/i);
  requireRegex("Helm network policy console ingress", networkPolicy, /name:\s*rpa-console-ingress[\s\S]*?app\.kubernetes\.io\/name:\s*rpa-console/i);
  requireRegex("Helm network policy console egress to api", networkPolicy, /name:\s*rpa-console-to-api-egress[\s\S]*?app\.kubernetes\.io\/name:\s*rpa-api[\s\S]*?port:\s*8080/i);
  requireRegex("Helm network policy egress default deny", networkPolicy, /name:\s*rpa-default-deny-egress[\s\S]*?egress:\s*\[\]/i);
  requireRegex("Helm network policy DNS egress", networkPolicy, /name:\s*rpa-dns-egress[\s\S]*?\.Values\.networkPolicy\.egress\.dnsNamespaceLabel[\s\S]*?port:\s*53/i);
  requireRegex("Helm network policy owner CIDRs", networkPolicy, /\.Values\.networkPolicy\.egress\.ownerApprovedCidrs/i);
  requireRegex("Helm network policy rejects all IPv4 egress", networkPolicy, /eq\s+\$cidr\s+"0\.0\.0\.0\/0"/i);
  requireRegex("Helm network policy rejects all IPv6 egress", networkPolicy, /eq\s+\$cidr\s+"::\/0"/i);
  requireRegex("Helm api PDB", pdb, /kind:\s*PodDisruptionBudget[\s\S]*?name:\s*rpa-api[\s\S]*?minAvailable:\s*1/i);
  requireRegex("Helm notes mention out-of-band DB roles", notes, /roles\.sql/i);
  requireRegex("Helm notes mention existing Secret", notes, /rpa-runtime-secrets/i);
  requireRegex("Helm notes mention immutable digest", notes, /image\.digest[\s\S]*immutable sha256/i);
  requireRegex("Helm notes mention console image digest", notes, /console\.image\.repository[\s\S]*console\.image\.digest/i);
  requireRegex("Helm notes mention console /api strip proxy", notes, /\/api\/\*[\s\S]*stripping \/api/i);
  requireRegex("Helm notes mention SBOM signing", notes, /SBOM[\s\S]*signature/i);
  requireRegex("Helm notes mention ingress owner decisions", notes, /ingress\.enabled=false[\s\S]*className[\s\S]*TLS secret/i);
  requireRegex("Helm notes mention egress owner decisions", notes, /Default egress is deny-all[\s\S]*ownerApprovedCidrs/i);
  rejectRegex("Helm templates must not render repository secrets", helmAll, /kind:\s*Secret|stringData:/i);
  rejectRegex("Helm runtime must not use postgres superuser", [api, worker, lifecycle].join("\n"), /\bPOSTGRES_USER\b|PGUSER:[\s\S]{0,80}postgres|postgresql:\/\/postgres/i);
}

function checkHelmReleaseValues() {
  requireRegex("Helm release example uses owner-approved repository sample", releaseValues, /repository:\s*registry\.owner-approved\.invalid\/rpa-runtime/i);
  requireRegex("Helm release example uses immutable digest", releaseValues, /digest:\s*sha256:[a-f0-9]{64}/i);
  requireRegex("Helm release example uses owner-approved console repository sample", releaseValues, /repository:\s*registry\.owner-approved\.invalid\/rpa-console/i);
  requireRegex("Helm release example keeps tag empty", releaseValues, /tag:\s*""/i);
  requireRegex("Helm release example sets staging namespace", releaseValues, /namespaceOverride:\s*rpa-staging/i);
  requireRegex("Helm release example includes owner-approved egress list", releaseValues, /ownerApprovedCidrs:[\s\S]*name:\s*managed-postgresql[\s\S]*name:\s*llm-provider/i);
  for (const cidr of ["192.0.2.10/32", "192.0.2.20/32", "198.51.100.10/32", "198.51.100.20/32", "203.0.113.10/32"]) {
    requireIn("Helm release example documentation CIDR", releaseValues, cidr);
  }
  rejectRegex("Helm release example must not carry unresolved owner placeholders", releaseValues, /OWNER_DECISION_REQUIRED_/);
  rejectRegex("Helm release example must not allow all IPv4", releaseValues, /0\.0\.0\.0\/0/);
  rejectRegex("Helm release example must not allow all IPv6", releaseValues, /::\/0/);
}

function checkOwnerDecisionNotes() {
  for (const [path, source] of Object.entries(ownerDecisionNotes)) {
    requireRegex(`${path} records blocked required decisions`, source, /TODO: \[BLOCKED\] Required decision:/);
  }
  requireRegex("owner decision notes require image digest approval", ownerDecisionAll, /image repository[\s\S]*immutable sha256 digest/i);
  requireRegex("owner decision notes require SBOM/provenance/signature", ownerDecisionAll, /SBOM[\s\S]*provenance[\s\S]*signature/i);
  requireRegex("owner decision notes require approved egress CIDRs", ownerDecisionAll, /destination CIDRs[\s\S]*managed PostgreSQL[\s\S]*LLM provider/i);
}

function checkPackagingDocs() {
  const k8sReadme = docs["deploy/k8s/README.md"];
  const prodPackaging = docs["docs/deploy/controlled-prod-packaging.md"];
  const runbook = docs["docs/staging-deploy-runbook.md"];

  requireRegex("K8s README calls base a fail-closed template", k8sReadme, /base\/`?\s+is a fail-closed template/i);
  requireRegex("K8s README names staging sample overlay", k8sReadme, /overlays\/staging-sample/i);
  requireRegex("K8s README requires immutable digest", k8sReadme, /immutable sha256 digest/i);
  requireRegex("K8s README requires SBOM signing evidence", k8sReadme, /SBOM[\s\S]*signing/i);
  requireRegex("K8s README requires owner approved egress CIDRs", k8sReadme, /owner-approved destination CIDRs/i);

  requireRegex("controlled prod doc records base fail-closed boundary", prodPackaging, /fail-closed template/i);
  requireRegex("controlled prod doc records Helm release example", prodPackaging, /values\.release\.example\.yaml/i);
  requireRegex("controlled prod doc records immutable digest", prodPackaging, /immutable sha256 digest/i);
  requireRegex("controlled prod doc records SBOM signing", prodPackaging, /SBOM[\s\S]*signing/i);
  requireRegex("controlled prod doc records owner-approved egress CIDR", prodPackaging, /owner-approved CIDRs/i);

  requireRegex("staging runbook records Kubernetes release overlay gate", runbook, /Kubernetes release overlay gate/i);
  requireRegex("staging runbook records Helm release values gate", runbook, /Helm release values gate/i);
  requireRegex("staging runbook records image digest requirement", runbook, /image\.digest/i);
  requireRegex("staging runbook records SBOM signing requirement", runbook, /SBOM[\s\S]*signature/i);
  requireRegex("staging runbook records console deployment", runbook, /Console deployment/i);
  requireRegex("staging runbook records console VITE_API_BASE_URL", runbook, /VITE_API_BASE_URL[\s\S]*\/api/i);
  requireRegex("staging runbook records console VITE_OIDC_AUTH_URL", runbook, /VITE_OIDC_AUTH_URL/i);
  requireRegex("staging runbook records console /api strip proxy", runbook, /strips the[\s\S]*\/api[\s\S]*\/v1/i);
  requireRegex("staging runbook records HTTPS secure-context guidance", runbook, /Use HTTPS[\s\S]*secure-context/i);
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

function requireConsoleDeploymentContract(label, source, replicasPattern) {
  requireRegex(`${label} replicas`, source, replicasPattern);
  requireRegex(`${label} service account`, source, /serviceAccountName:\s*rpa-console/i);
  requireRegex(`${label} automount disabled`, source, /automountServiceAccountToken:\s*false/i);
  requireRegex(`${label} non-root`, source, /runAsNonRoot:\s*true/i);
  requireRegex(`${label} nginx non-root uid`, source, /runAsUser:\s*101/i);
  requireRegex(`${label} no privilege escalation`, source, /allowPrivilegeEscalation:\s*false/i);
  requireRegex(`${label} http port`, source, /name:\s*http[\s\S]*?containerPort:\s*8080/i);
  requireRegex(`${label} readiness probe`, source, /readinessProbe:[\s\S]*?path:\s*\/healthz[\s\S]*?port:\s*http/i);
  requireRegex(`${label} liveness probe`, source, /livenessProbe:[\s\S]*?path:\s*\/healthz[\s\S]*?port:\s*http/i);
  requireRegex(`${label} API upstream env`, source, /name:\s*RPA_API_UPSTREAM[\s\S]*?(http:\/\/rpa-api:8080|\.Values\.console\.apiUpstream)/i);
  requireRegex(`${label} service`, source, /kind:\s*Service[\s\S]*?name:\s*rpa-console[\s\S]*?targetPort:\s*http/i);
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
      /preferredDuringSchedulingIgnoredDuringExecution|\.Values\.(worker|lifecycleWorker|console)\.affinity/i,
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

function serviceBlock(source, serviceName) {
  const pattern = new RegExp(`\\n  ${escapeRegex(serviceName)}:\\n([\\s\\S]*?)(?=\\n  [A-Za-z0-9_-]+:\\n|\\nvolumes:\\n|$)`);
  const match = pattern.exec(source);
  if (match === null) {
    failures.push(`compose.yaml missing service block ${serviceName}`);
    return "";
  }
  return match[0];
}
