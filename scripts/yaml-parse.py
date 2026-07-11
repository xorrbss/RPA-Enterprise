#!/usr/bin/env python3
from pathlib import Path
import sys

try:
    import yaml
except ImportError:
    print(
        "FAIL: PyYAML is required for YAML parsing. Install python3-yaml or PyYAML.",
        file=sys.stderr,
    )
    raise SystemExit(2)


ROOT = Path(__file__).resolve().parents[1]
BITBUCKET_PIPELINES = "bitbucket-pipelines.yml"
FILES = {
    "codegen/openapi.yaml": ("openapi", "paths", "components"),
    "codegen/asyncapi.yaml": ("asyncapi", "channels", "components"),
    # Bitbucket CI(contract-gates 이식본). 계약 전용 CI 불변식(배포 금지)은 호스트가 바뀌어도 유지된다.
    BITBUCKET_PIPELINES: ("image", "pipelines"),
}
WORKFLOW_DIR = ROOT / ".github" / "workflows"
DEPLOY_MARKERS = (
    "deploy",
    "kubectl",
    "helm upgrade",
    "terraform apply",
    "wrangler deploy",
)


def collect_targets() -> tuple[dict[str, tuple[str, ...]], list[str]]:
    failures: list[str] = []
    targets = dict(FILES)
    if not WORKFLOW_DIR.is_dir():
        failures.append(".github/workflows: missing directory")
        return targets, failures
    workflow_paths = sorted(
        path for path in WORKFLOW_DIR.iterdir() if path.is_file() and path.suffix in {".yml", ".yaml"}
    )
    if not workflow_paths:
        failures.append(".github/workflows: no workflow YAML files found")
    for path in workflow_paths:
        targets[str(path.relative_to(ROOT)).replace("\\", "/")] = ("name", "on", "jobs")
    return targets, failures


def check_bitbucket_contract_only(rel_path: str, document: dict) -> list[str]:
    """Bitbucket CI 도 계약 전용이어야 한다 — 배포 스텝(deploy/kubectl/helm upgrade …) 금지.

    GitHub 워크플로 가드와 동일 불변식. 스텝 이름과 script 명령만 본다(주석은 파싱에 안 남는다).
    definitions.steps 의 앵커 정의를 검사하면 pipelines 의 별칭 참조까지 전부 덮인다.
    """
    failures: list[str] = []
    definitions = document.get("definitions")
    steps = definitions.get("steps", []) if isinstance(definitions, dict) else []
    if not isinstance(steps, list):
        return [f"{rel_path}: definitions.steps must be a list"]
    if not steps:
        return [f"{rel_path}: definitions.steps must define at least one step"]
    for index, entry in enumerate(steps, start=1):
        step = entry.get("step") if isinstance(entry, dict) else None
        if not isinstance(step, dict):
            failures.append(f"{rel_path}: definitions.steps entry {index} is not a step mapping")
            continue
        name = str(step.get("name", "")).lower()
        script = step.get("script", [])
        commands = " ".join(str(item) for item in script).lower() if isinstance(script, list) else str(script).lower()
        if any(marker in name or marker in commands for marker in DEPLOY_MARKERS):
            failures.append(
                f"{rel_path}: contract-only CI must not deploy; step {step.get('name', index)!r} is deploy-like"
            )
    return failures


def main() -> int:
    failures: list[str] = []
    targets, target_failures = collect_targets()
    failures.extend(target_failures)
    for rel_path, required_keys in targets.items():
        path = ROOT / rel_path
        if not path.is_file():
            failures.append(f"{rel_path}: missing file")
            continue
        try:
            path.read_text(encoding="utf-8")
        except UnicodeDecodeError as exc:
            failures.append(f"{rel_path}: not valid UTF-8: {exc}")
            continue
        try:
            with path.open("r", encoding="utf-8") as handle:
                loader = yaml.BaseLoader if rel_path.startswith(".github/workflows/") else yaml.SafeLoader
                document = yaml.load(handle, Loader=loader)
        except yaml.YAMLError as exc:
            failures.append(f"{rel_path}: YAML parse failed: {exc}")
            continue
        if not isinstance(document, dict):
            failures.append(f"{rel_path}: YAML root must be a mapping")
            continue
        for key in required_keys:
            if key not in document:
                failures.append(f"{rel_path}: missing top-level key {key!r}")
        if rel_path == BITBUCKET_PIPELINES:
            failures.extend(check_bitbucket_contract_only(rel_path, document))
        if rel_path.startswith(".github/workflows/"):
            triggers = document.get("on")
            if isinstance(triggers, dict) and "pull_request_target" in triggers:
                failures.append(f"{rel_path}: contract-only workflow must not use pull_request_target")
            jobs = document.get("jobs", {})
            if isinstance(jobs, dict):
                for job_name, job_body in jobs.items():
                    lower_name = str(job_name).lower()
                    lower_label = ""
                    has_environment = False
                    steps = []
                    if isinstance(job_body, dict):
                        lower_label = str(job_body.get("name", "")).lower()
                        has_environment = "environment" in job_body
                        raw_steps = job_body.get("steps", [])
                        if isinstance(raw_steps, list):
                            steps = raw_steps
                    if "deploy" in lower_name or "deploy" in lower_label or has_environment:
                        failures.append(
                            f"{rel_path}: contract-only workflow must not deploy or bind a GitHub Environment; job {job_name!r} is deploy-like"
                        )
                    for index, step in enumerate(steps, start=1):
                        if not isinstance(step, dict):
                            continue
                        step_name = str(step.get("name", "")).lower()
                        uses = str(step.get("uses", "")).lower()
                        run_body = str(step.get("run", "")).lower()
                        if any(marker in step_name or marker in uses or marker in run_body for marker in DEPLOY_MARKERS):
                            failures.append(
                                f"{rel_path}: contract-only workflow step {index} in job {job_name!r} is deploy-like"
                            )
                        if not uses.startswith("actions/checkout@"):
                            continue
                        with_body = step.get("with", {})
                        persist_credentials = None
                        if isinstance(with_body, dict):
                            persist_credentials = with_body.get("persist-credentials")
                        if str(persist_credentials).lower() != "false":
                            failures.append(
                                f"{rel_path}: checkout step {index} in job {job_name!r} must set persist-credentials: false"
                            )
        print(f"parsed {rel_path}")

    if failures:
        print(f"yaml parse: {len(failures)} failed", file=sys.stderr)
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1

    print(f"yaml parse: {len(targets)} files checked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
