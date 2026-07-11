#!/usr/bin/env python3
"""Kubernetes packaging RENDER smoke.

k8s-static-smoke.mjs 는 매니페스트 **텍스트를 regex 로만** 본다. 그래서 템플릿이 실제로 렌더되는지, 렌더 결과가
유효한 오브젝트인지, 그리고 컨테이너가 런타임이 부팅에 **요구하는 env 를 실제로 갖는지**는 아무도 확인한 적이 없다.
(compose 에서 정확히 이 갭이 P0 로 드러났다: worker 가 VAULT_*/CODEX_* 없이 선언돼 있어 부팅 불가였다.)

이 게이트는 helm/kustomize 로 실제 렌더한 뒤 렌더 산출물을 검증한다. 클러스터에 적용하지 않는다(읽기 전용).

필수 env 목록의 근거(코드):
- 공통: app/src/config/env.ts    — PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD, RPA_ENV
- worker: app/src/config/env-worker.ts (WORKER_ID) · env-primitives.ts loadVaultIdentity(VAULT_ADDR,
  VAULT_RUNTIME_WORKER_ROLE_ID, VAULT_RUNTIME_WORKER_SECRET_ID) · env-gateway.ts loadGatewayConfig
  (CODEX_BASE_URL/CODEX_API_KEY/CODEX_MODEL 무조건 req)
- lifecycle-worker: app/src/config/env-artifact-lifecycle.ts (ARTIFACT_LIFECYCLE_DATABASE_URL,
  ARTIFACT_LIFECYCLE_WORKER_ID, ARTIFACT_OBJECT_STORE_REF)
- api: app/src/config/env-auth.ts (JWT_HS256_SECRET 또는 JWKS_URL) · env.ts (SIGNED_COMMAND_REGISTRY_MODE)
"""
from pathlib import Path
from shutil import which
import subprocess
import sys

try:
    import yaml
except ImportError:
    print("FAIL: PyYAML is required. Install python3-yaml or PyYAML.", file=sys.stderr)
    raise SystemExit(2)

ROOT = Path(__file__).resolve().parents[1]
CHART = "deploy/helm/rpa"
RELEASE_VALUES = "deploy/helm/rpa/values.release.example.yaml"
KUSTOMIZE_TARGETS = ["deploy/k8s/base", "deploy/k8s/overlays/staging-sample"]

COMMON_ENV = ["RPA_ENV", "PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]
REQUIRED_ENV_BY_RUN_MODE = {
    "worker": COMMON_ENV + [
        "WORKER_ID",
        "VAULT_ADDR",
        "VAULT_RUNTIME_WORKER_ROLE_ID",
        "VAULT_RUNTIME_WORKER_SECRET_ID",
        "CODEX_BASE_URL",
        "CODEX_API_KEY",
        "CODEX_MODEL",
        "CHROME_EXECUTABLE_PATH",
        "ARTIFACT_LIFECYCLE_CONSUMER",
    ],
    "lifecycle-worker": COMMON_ENV + [
        "ARTIFACT_LIFECYCLE_DATABASE_URL",
        "ARTIFACT_LIFECYCLE_WORKER_ID",
        "ARTIFACT_OBJECT_STORE_REF",
    ],
    "api": COMMON_ENV + ["SIGNED_COMMAND_REGISTRY_MODE"],
}
API_AUTH_ENV = ["JWT_HS256_SECRET", "JWKS_URL"]
MIGRATE_REQUIRED_FLAGS = ["--baseline-existing", "--graphile-worker", "--require-non-bypass"]

# 오브젝트 스토어를 s3 로 켜면 각 워크로드가 요구하는 env 가 달라진다(fail-closed). 매니페스트가 모드만 켜고
# 필요한 env 를 안 주면 컨테이너가 부팅조차 못 한다 — 실제로 API 가 그 상태였다(ARTIFACT_OBJECT_STORE_KIND=s3
# 인데 엔드포인트/버킷 env 부재). 모드에 따라 조건부로 검사한다.
# 엔드포인트/리전/버킷/키는 정규 계열(ARTIFACT_OBJECT_STORE_S3_*) 또는 레거시(S3_*) 중 하나면 된다.
S3_ENDPOINT_ALIASES = [
    ["ARTIFACT_OBJECT_STORE_S3_ENDPOINT", "S3_ENDPOINT"],
    ["ARTIFACT_OBJECT_STORE_S3_REGION", "S3_REGION"],
    ["ARTIFACT_OBJECT_STORE_S3_BUCKET", "S3_BUCKET"],
    ["ARTIFACT_OBJECT_STORE_S3_ACCESS_KEY_ID", "S3_ACCESS_KEY_ID"],
]
CONDITIONAL_S3_ENV = {
    # (RUN_MODE, 모드를 켜는 env, s3 를 뜻하는 값) -> 그때 추가로 필요한 env
    ("api", "ARTIFACT_OBJECT_STORE_KIND", "s3"): [
        "ARTIFACT_OBJECT_STORE_REF",
        "VAULT_ADDR",
        "VAULT_API_ROLE_ID",
        "VAULT_API_SECRET_ID",
    ],
    ("worker", "GATEWAY_ARTIFACT_STORE_MODE", "s3"): [
        "GATEWAY_ARTIFACT_OBJECT_STORE_REF",
        "VAULT_ADDR",
        "VAULT_RUNTIME_WORKER_ROLE_ID",
        "VAULT_RUNTIME_WORKER_SECRET_ID",
    ],
    ("lifecycle-worker", "ARTIFACT_LIFECYCLE_OBJECT_STORE_MODE", "s3"): [
        "ARTIFACT_OBJECT_STORE_REF",
        "VAULT_ADDR",
        "VAULT_ARTIFACT_LIFECYCLE_ROLE_ID",
        "VAULT_ARTIFACT_LIFECYCLE_SECRET_ID",
    ],
}

WORKLOAD_KINDS = {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob"}

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)


def render(label: str, command: list[str]) -> list[dict]:
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        fail(f"{label}: render failed ({' '.join(command)}): {detail[-1] if detail else 'no output'}")
        return []
    try:
        docs = [doc for doc in yaml.safe_load_all(result.stdout) if doc is not None]
    except yaml.YAMLError as exc:
        fail(f"{label}: rendered output is not valid YAML: {exc}")
        return []
    if not docs:
        fail(f"{label}: rendered no objects")
        return []
    print(f"rendered {label}: {len(docs)} object(s)")
    return docs


def pod_spec(doc: dict) -> dict | None:
    kind = doc.get("kind")
    spec = doc.get("spec") or {}
    if kind in {"Deployment", "StatefulSet", "DaemonSet", "Job"}:
        return (spec.get("template") or {}).get("spec")
    if kind == "CronJob":
        job = (spec.get("jobTemplate") or {}).get("spec") or {}
        return (job.get("template") or {}).get("spec")
    return None


def env_sources(docs: list[dict]) -> dict[tuple[str, str], dict[str, str]]:
    """rendered ConfigMap/Secret 의 key→value — envFrom 해석 및 RUN_MODE 판별용."""
    sources: dict[tuple[str, str], dict[str, str]] = {}
    for doc in docs:
        kind = doc.get("kind")
        if kind not in {"ConfigMap", "Secret"}:
            continue
        name = (doc.get("metadata") or {}).get("name")
        entries: dict[str, str] = {}
        for field in ("data", "stringData"):
            block = doc.get(field)
            if isinstance(block, dict):
                for key, value in block.items():
                    entries[str(key)] = "" if value is None else str(value)
        sources[(kind, str(name))] = entries
    return sources


def container_env(container: dict, sources: dict[tuple[str, str], dict[str, str]], label: str) -> dict[str, str]:
    """컨테이너가 실제로 보게 되는 env 이름→값(값을 모르면 빈 문자열). envFrom 이 우선순위가 낮다."""
    resolved: dict[str, str] = {}
    for entry in container.get("envFrom") or []:
        if not isinstance(entry, dict):
            continue
        for ref_field, kind in (("configMapRef", "ConfigMap"), ("secretRef", "Secret")):
            ref = entry.get(ref_field)
            if not isinstance(ref, dict):
                continue
            key = (kind, str(ref.get("name")))
            if key in sources:
                resolved.update(sources[key])
            else:
                # 렌더 산출물에 없는 소스는 키를 증명할 수 없다 — 조용히 통과시키지 않는다.
                fail(f"{label}: envFrom references {kind}/{ref.get('name')} that the rendering does not define")
    for entry in container.get("env") or []:
        if isinstance(entry, dict) and "name" in entry:
            # value 없이 valueFrom(secretKeyRef 등)만 있으면 존재는 증명되고 값은 알 수 없다.
            resolved[str(entry["name"])] = str(entry.get("value", ""))
    return resolved


def check_workloads(label: str, docs: list[dict]) -> None:
    sources = env_sources(docs)
    seen_run_modes: set[str] = set()
    migrate_checked = False

    for doc in docs:
        kind = doc.get("kind")
        if not isinstance(doc, dict) or kind is None or doc.get("apiVersion") is None:
            fail(f"{label}: rendered object without apiVersion/kind: {str(doc)[:80]}")
            continue
        name = (doc.get("metadata") or {}).get("name")
        if not name:
            fail(f"{label}: {kind} object without metadata.name")
            continue
        if kind not in WORKLOAD_KINDS:
            continue

        spec = pod_spec(doc)
        if spec is None:
            fail(f"{label}: {kind}/{name} has no pod spec")
            continue
        containers = spec.get("containers") or []
        if not containers:
            fail(f"{label}: {kind}/{name} declares no containers")
            continue

        for container in containers:
            cname = container.get("name", "?")
            where = f"{label}: {kind}/{name}/{cname}"
            if not container.get("image"):
                fail(f"{where}: container has no image")
            resolved = container_env(container, sources, where)

            command = " ".join(str(part) for part in (container.get("command") or []) + (container.get("args") or []))
            if "db-migrate.mjs" in command:
                migrate_checked = True
                for flag in MIGRATE_REQUIRED_FLAGS:
                    if flag not in command:
                        fail(f"{where}: migration command is missing {flag} ({command})")
                continue

            run_mode = resolved.get("RUN_MODE")
            if not run_mode:
                continue
            seen_run_modes.add(run_mode)
            required = REQUIRED_ENV_BY_RUN_MODE.get(run_mode)
            if required is None:
                fail(f"{where}: unknown RUN_MODE {run_mode!r}")
                continue
            missing = [key for key in required if key not in resolved]
            if missing:
                fail(f"{where}: RUN_MODE={run_mode} is missing required env: {', '.join(missing)}")
            if run_mode == "api" and not any(key in resolved for key in API_AUTH_ENV):
                fail(f"{where}: api needs one of {' / '.join(API_AUTH_ENV)}")

            for (mode_run, mode_key, mode_value), extra in CONDITIONAL_S3_ENV.items():
                if mode_run != run_mode or resolved.get(mode_key, "").lower() != mode_value:
                    continue
                missing_s3 = [key for key in extra if key not in resolved]
                if missing_s3:
                    fail(f"{where}: {mode_key}={mode_value} but missing: {', '.join(missing_s3)}")
                for aliases in S3_ENDPOINT_ALIASES:
                    if not any(alias in resolved for alias in aliases):
                        fail(f"{where}: {mode_key}={mode_value} but none of {' / '.join(aliases)} is set")

    for run_mode in REQUIRED_ENV_BY_RUN_MODE:
        if run_mode not in seen_run_modes:
            fail(f"{label}: no workload declares RUN_MODE={run_mode}")
    if not migrate_checked:
        fail(f"{label}: no migration workload runs scripts/db-migrate.mjs")


def main() -> int:
    for tool in ("helm", "kustomize"):
        if which(tool) is None:
            print(f"FAIL: {tool} is required for the packaging render smoke.", file=sys.stderr)
            return 2

    helm_docs = render(
        "helm chart (release values)",
        ["helm", "template", "rpa", CHART, "--values", RELEASE_VALUES],
    )
    if helm_docs:
        check_workloads("helm chart (release values)", helm_docs)

    for target in KUSTOMIZE_TARGETS:
        docs = render(target, ["kustomize", "build", target])
        if docs:
            check_workloads(target, docs)

    if failures:
        print(f"k8s render smoke: {len(failures)} failed", file=sys.stderr)
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1

    print("k8s render smoke: helm + kustomize render, objects valid, workload env satisfies runtime requirements")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
