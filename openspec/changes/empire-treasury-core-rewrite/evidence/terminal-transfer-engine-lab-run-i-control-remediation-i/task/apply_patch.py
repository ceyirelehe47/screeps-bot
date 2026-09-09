#!/usr/bin/env python3
"""Verify the fixed baseline and apply this package's patch. No commit/push/run."""
from __future__ import annotations
import argparse
import hashlib
import json
import subprocess
import sys
from pathlib import Path


def git(repo: Path, *args: str) -> str:
    return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, type=Path)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    package = Path(__file__).resolve().parent
    manifest = json.loads((package / "source-manifest.json").read_text(encoding="utf-8"))
    repo = Path(git(args.repo.resolve(), "rev-parse", "--show-toplevel")).resolve()
    head = git(repo, "rev-parse", "HEAD")
    if head != manifest["baseCommit"]:
        raise RuntimeError(f"BASE mismatch: expected {manifest['baseCommit']}, actual {head}; no reset or override")
    if git(repo, "status", "--porcelain=v1", "--untracked-files=all"):
        raise RuntimeError("working tree is not clean; keep this package outside the repository")
    patch = package / "changes.patch"
    if hashlib.sha256(patch.read_bytes()).hexdigest() != manifest["patchSha256"]:
        raise RuntimeError("patch checksum mismatch")
    for item in manifest["frozenInputs"] + manifest["files"]:
        relative = Path(item["path"])
        if relative.is_absolute() or ".." in relative.parts:
            raise RuntimeError("unsafe manifest path")
        target = repo / relative
        if not target.resolve().is_relative_to(repo):
            raise RuntimeError(f"path escapes repository: {relative}")
        expected = item.get("originalGitBlobSha")
        if expected:
            if not target.is_file() or blob_sha(target.read_bytes()) != expected:
                raise RuntimeError(f"source bytes differ: {relative}")
        elif target.exists() or target.is_symlink():
            raise RuntimeError(f"new path already exists: {relative}")
    for item in manifest["files"]:
        shipped = package / "modified-files" / item["path"]
        if hashlib.sha256(shipped.read_bytes()).hexdigest() != item["sha256"]:
            raise RuntimeError(f"shipped file checksum mismatch: {item['path']}")
    subprocess.run(["git", "-C", str(repo), "apply", "--check", str(patch)], check=True)
    if args.check_only:
        print("BASE, source bytes and git apply --check: OK; no changes made")
        return
    subprocess.run(["git", "-C", str(repo), "apply", str(patch)], check=True)
    for item in manifest["files"]:
        actual = hashlib.sha256((repo / item["path"]).read_bytes()).hexdigest()
        if actual != item["sha256"]:
            raise RuntimeError(f"post-apply checksum mismatch: {item['path']}; do not auto-reset")
    print(f"Applied {len(manifest['files'])} files on {head}. No commit, push or game action performed.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, RuntimeError, ValueError, subprocess.CalledProcessError) as error:
        print(f"REFUSED: {error}", file=sys.stderr)
        sys.exit(1)
