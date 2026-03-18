#!/usr/bin/env python3
"""
Export a directory from a Git repository using treeless + sparse clone.

Workflow:
1. Clone repository with --filter=tree:0 --sparse --no-checkout.
2. Configure sparse-checkout for the requested directory.
3. Checkout the requested ref (or default branch).
4. Copy only the requested directory contents to output.
5. Always remove .git from the output.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
from pathlib import Path


class GitExportError(RuntimeError):
    """Domain error for export failures."""


def info(message: str) -> None:
    print(f"[git-export] {message}", flush=True)


def run_git(
    git_bin: str, args: list[str], cwd: Path | None = None, verbose: bool = False
) -> None:
    cmd = [git_bin, *args]
    if verbose:
        location = str(cwd) if cwd else os.getcwd()
        print(f"+ (cwd={location}) {' '.join(cmd)}")
    try:
        subprocess.run(
            cmd,
            cwd=str(cwd) if cwd else None,
            check=True,
            text=True,
            capture_output=True,
        )
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or "").strip()
        stdout = (e.stdout or "").strip()
        detail = stderr or stdout or str(e)
        raise GitExportError(f"git command failed: {' '.join(cmd)}\n{detail}") from e


def normalize_source_path(path: str) -> str:
    source = path.strip().strip("/")
    if not source:
        raise GitExportError("Source path must not be empty")
    parts = [p for p in source.split("/") if p not in ("", ".")]
    if any(part == ".." for part in parts):
        raise GitExportError("Source path must not contain '..'")
    return "/".join(parts)


def parse_github_directory_url(url: str) -> tuple[str, str, str | None]:
    """
    Parse a GitHub directory URL into (repo_url, source_path, ref).

    Supported examples:
    - https://github.com/org/repo/lang/ruby
    - https://github.com/org/repo/tree/main/lang/ruby
    - https://github.com/org/repo/blob/main/lang/ruby
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or parsed.netloc not in (
        "github.com",
        "www.github.com",
    ):
        raise GitExportError(f"Not a supported GitHub URL: {url}")

    parts = [p for p in parsed.path.split("/") if p]
    if len(parts) < 3:
        raise GitExportError(
            f"GitHub URL must include a directory path after owner/repo (got: {url})"
        )

    owner = parts[0]
    repo = parts[1]
    if repo.endswith(".git"):
        repo = repo[:-4]

    rest = parts[2:]
    ref: str | None = None
    source: str

    if rest[0] in ("tree", "blob"):
        if len(rest) < 3:
            raise GitExportError(
                f"tree/blob URLs must include ref and directory path, got: {url}"
            )
        ref = rest[1]
        source = "/".join(rest[2:])
    else:
        source = "/".join(rest)

    repo_url = f"https://github.com/{owner}/{repo}.git"
    return repo_url, normalize_source_path(source), ref


def prepare_output_dir(output_dir: Path, force: bool) -> None:
    if output_dir.exists():
        if not force:
            raise GitExportError(
                f"Output path already exists: {output_dir} (use --force to overwrite)"
            )
        if output_dir.is_file() or output_dir.is_symlink():
            output_dir.unlink()
        else:
            shutil.rmtree(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)


def copy_entry(src: Path, dst: Path) -> None:
    if src.is_symlink():
        target = os.readlink(src)
        if dst.exists() or dst.is_symlink():
            if dst.is_dir() and not dst.is_symlink():
                shutil.rmtree(dst)
            else:
                dst.unlink()
        os.symlink(target, dst)
        return
    if src.is_dir():
        shutil.copytree(src, dst, symlinks=True, dirs_exist_ok=True)
        return
    shutil.copy2(src, dst, follow_symlinks=False)


def export_directory(
    repo_url: str,
    source_path: str,
    output_dir: Path,
    ref: str | None,
    depth: int,
    force: bool,
    git_bin: str,
    verbose: bool,
) -> None:
    start_total = time.perf_counter()
    source_path = normalize_source_path(source_path)
    output_dir = output_dir.resolve()

    info(f"Repository: {repo_url}")
    info(f"Source path: {source_path}")
    info(f"Ref: {ref or 'default branch'}")
    info(f"Output: {output_dir}")

    with tempfile.TemporaryDirectory(prefix="git-export-") as temp_dir:
        work_dir = Path(temp_dir)
        clone_dir = work_dir / "repo"

        info("Step 1/6: cloning repository (treeless + sparse, no checkout)")
        step_start = time.perf_counter()
        run_git(
            git_bin,
            [
                "clone",
                "--depth",
                str(depth),
                "--filter=tree:0",
                "--sparse",
                "--no-checkout",
                repo_url,
                str(clone_dir),
            ],
            verbose=verbose,
        )
        info(f"Step 1/6 complete in {time.perf_counter() - step_start:.1f}s")

        info("Step 2/6: configuring sparse checkout")
        step_start = time.perf_counter()
        run_git(
            git_bin,
            ["sparse-checkout", "init", "--cone"],
            cwd=clone_dir,
            verbose=verbose,
        )
        run_git(
            git_bin,
            ["sparse-checkout", "set", "--", source_path],
            cwd=clone_dir,
            verbose=verbose,
        )
        info(f"Step 2/6 complete in {time.perf_counter() - step_start:.1f}s")

        info("Step 3/6: checking out requested ref/path")
        step_start = time.perf_counter()
        if ref:
            run_git(
                git_bin,
                ["fetch", "--depth", str(depth), "origin", ref],
                cwd=clone_dir,
                verbose=verbose,
            )
            run_git(
                git_bin,
                ["checkout", "--detach", "FETCH_HEAD"],
                cwd=clone_dir,
                verbose=verbose,
            )
        else:
            run_git(git_bin, ["checkout"], cwd=clone_dir, verbose=verbose)
        info(f"Step 3/6 complete in {time.perf_counter() - step_start:.1f}s")

        info("Step 4/6: validating source directory")
        source_dir = clone_dir / source_path
        if not source_dir.exists() or not source_dir.is_dir():
            raise GitExportError(
                f"Source directory not found after checkout: {source_path}\n"
                f"Repository: {repo_url}\n"
                f"Ref: {ref or 'default branch'}"
            )
        info("Step 4/6 complete")

        info("Step 5/6: preparing output directory")
        step_start = time.perf_counter()
        prepare_output_dir(output_dir, force=force)
        info(f"Step 5/6 complete in {time.perf_counter() - step_start:.1f}s")

        info("Step 6/6: copying exported files")
        step_start = time.perf_counter()
        children = list(source_dir.iterdir())
        total_children = len(children)
        if total_children == 0:
            info("Source directory is empty")
        for idx, child in enumerate(children, start=1):
            info(f"  - [{idx}/{total_children}] {child.name}")
            copy_entry(child, output_dir / child.name)
        info(f"Step 6/6 complete in {time.perf_counter() - step_start:.1f}s")

    info("Finalizing export (removing .git if present)")
    shutil.rmtree(output_dir / ".git", ignore_errors=True)
    info(f"Export complete in {time.perf_counter() - start_total:.1f}s")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Export a directory from a GitHub repository"
    )
    parser.add_argument("source", help="GitHub directory URL or repo URL")
    parser.add_argument("output", help="Output directory path")
    parser.add_argument("--ref", default=None, help="Git ref to checkout")
    parser.add_argument(
        "--path",
        default=None,
        help="Directory path inside the repo (required for raw repo URLs)",
    )
    parser.add_argument("--depth", type=int, default=1, help="Clone depth (default: 1)")
    parser.add_argument("--git", default="git", help="Git binary to use (default: git)")
    parser.add_argument(
        "--force", action="store_true", help="Overwrite output if it exists"
    )
    parser.add_argument("--verbose", action="store_true", help="Print git commands")
    return parser


def main(argv: list[str]) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    output_dir = Path(args.output)

    try:
        if args.source.startswith("https://github.com/"):
            repo_url, source_path, inferred_ref = parse_github_directory_url(
                args.source
            )
            ref = args.ref if args.ref is not None else inferred_ref
        else:
            if not args.path:
                raise GitExportError(
                    "--path is required when source is not a GitHub directory URL"
                )
            repo_url = args.source
            source_path = normalize_source_path(args.path)
            ref = args.ref

        export_directory(
            repo_url=repo_url,
            source_path=source_path,
            output_dir=output_dir,
            ref=ref,
            depth=args.depth,
            force=args.force,
            git_bin=args.git,
            verbose=args.verbose,
        )
        return 0
    except GitExportError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
