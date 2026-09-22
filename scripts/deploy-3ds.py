#!/usr/bin/env python3
"""Publish the verified production SD stage to ftpd, then hash its readback."""
import argparse
import ftplib
import hashlib
import json
from pathlib import Path
from uuid import uuid4

ROOT = Path(__file__).resolve().parent.parent


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def remote_digest(ftp, path):
    value = hashlib.sha256()
    ftp.retrbinary(f"RETR {path}", value.update, blocksize=65536)
    return value.hexdigest()


def publish_file(ftp, temporary, destination, expected, previous=None):
    # 3DS ftpd cannot rename over an existing file. Keep the old version until
    # the replacement has passed its final-path readback, and restore on failure.
    backup = f"{destination}.previous-{uuid4().hex}" if previous is not None else None
    if backup:
        ftp.rename(destination, backup)
    installed = False
    try:
        ftp.rename(temporary, destination)
        installed = True
        if remote_digest(ftp, destination) != expected:
            raise RuntimeError(f"Published readback mismatch: {destination}")
    except Exception:
        if backup:
            if installed:
                ftp.delete(destination)
            ftp.rename(backup, destination)
        raise
    if backup:
        ftp.delete(backup)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True)
    parser.add_argument("--port", type=int, default=5000)
    args = parser.parse_args()
    build = json.loads((ROOT / "dist/3ds/build.json").read_text())
    if build.get("capture") is not False:
        raise RuntimeError("Build a production binary with bun run build:3ds first")
    stage = ROOT / "dist/3ds/sd/3ds/OpenStrike"
    for item in build["files"]:
        source = (stage / item["path"]).resolve()
        if not source.is_relative_to(stage) or source.stat().st_size != item["bytes"] or digest(source) != item["sha256"]:
            raise RuntimeError(f"Stage differs from build receipt: {source}")
    receipts = []
    with ftplib.FTP() as ftp:
        ftp.connect(args.host, args.port, timeout=30)
        ftp.login()
        for directory in ["/3ds", "/3ds/OpenStrike", "/3ds/OpenStrike/maps"]:
            try:
                ftp.mkd(directory)
            except ftplib.error_perm:
                ftp.cwd(directory)  # An existing directory must be accessible.
        for item in build["files"]:
            destination = f'/3ds/OpenStrike/{item["path"]}'
            try:
                current = remote_digest(ftp, destination)
            except (ftplib.error_perm, ftplib.error_temp) as error:
                # 3DS ftpd reports a missing RETR target as 450; other FTP
                # servers commonly use 550. Do not swallow busy/I/O errors.
                message = str(error).lower()
                if message[:3] not in ("450", "550") or not any(
                    reason in message for reason in ("no such file", "not found", "does not exist")
                ):
                    raise
                current = None
            if current != item["sha256"]:
                temporary = destination + ".upload"
                print(f'Upload {item["path"]} ({item["bytes"]:,} bytes)', flush=True)
                with (stage / item["path"]).open("rb") as source:
                    ftp.storbinary(f"STOR {temporary}", source, blocksize=65536)
                if remote_digest(ftp, temporary) != item["sha256"]:
                    raise RuntimeError(f"FTP readback mismatch: {temporary}")
                publish_file(ftp, temporary, destination, item["sha256"], current)
            if remote_digest(ftp, destination) != item["sha256"]:
                raise RuntimeError(f"Published readback mismatch: {destination}")
            receipts.append({**item, "remote": destination, "verified": True})
            print(f'Verified {item["path"]}', flush=True)
    output = ROOT / ".pocket/3ds-last-deploy.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps({"host": args.host, "port": args.port, "files": receipts}, indent=2) + "\n")
    print(f"Deployment receipt: {output}")


if __name__ == "__main__":
    main()
