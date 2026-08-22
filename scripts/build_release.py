#!/usr/bin/env python3
"""Build a deterministic CodeFolderSync release archive."""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import tarfile
from pathlib import Path

VERSION = "0.2.1"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=Path("release"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    files = [root / "LICENSE", root / "README.md", root / "scripts/install.py"]
    files.extend(sorted(path for path in (root / "dist").rglob("*") if path.is_file()))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    archive_path = args.output_dir / f"codefoldersync-{VERSION}.tar.gz"
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for source in files:
            relative = source.relative_to(root)
            info = archive.gettarinfo(str(source), arcname=f"codefoldersync-{VERSION}/{relative}")
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.mtime = 0
            with source.open("rb") as handle:
                archive.addfile(info, handle)
    with archive_path.open("wb") as output:
        with gzip.GzipFile(filename="", mode="wb", fileobj=output, mtime=0) as compressed:
            compressed.write(buffer.getvalue())
    digest = hashlib.sha256(archive_path.read_bytes()).hexdigest()
    checksum = archive_path.with_suffix(archive_path.suffix + ".sha256")
    checksum.write_text(f"{digest}  {archive_path.name}\n", encoding="utf-8")
    print(archive_path)
    print(checksum)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
