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
FILES = {
    ".github/workflows/contract-gates.yml": ("name", "jobs"),
    "codegen/openapi.yaml": ("openapi", "paths", "components"),
    "codegen/asyncapi.yaml": ("asyncapi", "channels", "components"),
}


def main() -> int:
    failures: list[str] = []
    for rel_path, required_keys in FILES.items():
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
                document = yaml.safe_load(handle)
        except yaml.YAMLError as exc:
            failures.append(f"{rel_path}: YAML parse failed: {exc}")
            continue
        if not isinstance(document, dict):
            failures.append(f"{rel_path}: YAML root must be a mapping")
            continue
        for key in required_keys:
            if key not in document:
                failures.append(f"{rel_path}: missing top-level key {key!r}")
        if rel_path.endswith("contract-gates.yml"):
            jobs = document.get("jobs", {})
            if isinstance(jobs, dict):
                for job_name, job_body in jobs.items():
                    lower_name = str(job_name).lower()
                    lower_label = ""
                    has_environment = False
                    if isinstance(job_body, dict):
                        lower_label = str(job_body.get("name", "")).lower()
                        has_environment = "environment" in job_body
                    if "deploy" in lower_name or "deploy" in lower_label or has_environment:
                        failures.append(
                            f"{rel_path}: contract-only workflow must not deploy or bind a GitHub Environment; job {job_name!r} is deploy-like"
                        )
        print(f"parsed {rel_path}")

    if failures:
        print(f"yaml parse: {len(failures)} failed", file=sys.stderr)
        for failure in failures:
            print(f"FAIL: {failure}", file=sys.stderr)
        return 1

    print(f"yaml parse: {len(FILES)} files checked")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
