#!/usr/bin/env python3
"""Install or verify a CodeFolderSync release."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
from pathlib import Path

VERSION = "0.3.0"


def release_root() -> Path:
    return Path(__file__).resolve().parent.parent


def locations(args: argparse.Namespace) -> tuple[Path, Path, Path]:
    install_root = args.install_root.expanduser().resolve()
    binary = args.bin_dir.expanduser().resolve() / "codefoldersync"
    version_directory = install_root / VERSION
    return install_root, binary, version_directory


def node_command() -> str:
    node = shutil.which("node")
    if node is None:
        raise RuntimeError("Node.js 22 or newer is required")
    result = subprocess.run([node, "--version"], text=True, capture_output=True, check=False)
    match = re.fullmatch(r"v?(\d+)\.\d+\.\d+\s*", result.stdout)
    if result.returncode or match is None or int(match.group(1)) < 22:
        raise RuntimeError("Node.js 22 or newer is required")
    return node


def verify(args: argparse.Namespace) -> tuple[bool, list[str]]:
    _, binary, version_directory = locations(args)
    errors: list[str] = []
    if not (version_directory / "product-cli.js").is_file():
        errors.append(f"installed release is missing: {version_directory}")
    if not binary.is_file():
        errors.append(f"command is missing: {binary}")
    else:
        result = subprocess.run([str(binary), "--version", "--json"], text=True, capture_output=True, check=False)
        try:
            identity = json.loads(result.stdout)
        except json.JSONDecodeError:
            identity = {}
        if (
            result.returncode
            or identity.get("version") != VERSION
            or identity.get("releaseSha256") != args.release_sha256
        ):
            errors.append(f"command is not the accepted CodeFolderSync {VERSION} release")
    return not errors, errors


def emit(args: argparse.Namespace, ready: bool, changed: bool, errors: list[str]) -> int:
    _, binary, version_directory = locations(args)
    report = {
        "component": "codefoldersync",
        "version": VERSION,
        "release_sha256": args.release_sha256,
        "ready": ready,
        "changed": changed,
        "command": str(binary),
        "version_directory": str(version_directory),
        "errors": errors,
    }
    print(json.dumps(report, sort_keys=True) if args.json else f"CodeFolderSync {VERSION}: {'ready' if ready else 'not ready'}")
    return 0 if ready else 1


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("--verify", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--release-sha256", required=True)
    parser.add_argument("--install-root", type=Path, default=Path.home() / ".local/lib/codefoldersync")
    parser.add_argument("--bin-dir", type=Path, default=Path.home() / ".local/bin")
    args = parser.parse_args()
    try:
        ready, errors = verify(args)
        if args.verify or ready:
            return emit(args, ready, False, errors)
        _, _, version_directory = locations(args)
        if version_directory.exists():
            raise RuntimeError(f"refusing to replace existing release: {version_directory}")
        node = node_command()
        built = release_root() / "dist"
        if not (built / "product-cli.js").is_file():
            raise RuntimeError("release build is missing")
        command = [
            node,
            str(built / "product-cli.js"),
            "install",
            "--built",
            str(built),
            "--install-root",
            str(args.install_root.expanduser().resolve()),
            "--bin-dir",
            str(args.bin_dir.expanduser().resolve()),
            "--release-sha256",
            args.release_sha256,
        ]
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        if result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip() or "installation failed")
        ready, errors = verify(args)
        return emit(args, ready, True, errors)
    except (OSError, RuntimeError) as error:
        return emit(args, False, False, [str(error)])


if __name__ == "__main__":
    raise SystemExit(main())
