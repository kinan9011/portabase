#!/usr/bin/env python3
"""Poisoned / valid tar.gz fixture builder for the portabase-recover tests (W14b). Test tooling only: it builds hostile archives ON PURPOSE
(traversal, symlink escape, devices, setuid, bombs ...) so the audit in `decrypt-archive --audit-tar` can be proven to reject them.

Usage: tarfix.py OUTDIR      -> writes OUTDIR/<case>.tar.gz and prints '<case> <ok|reject>' lines (expected verdict of the audit).
"""
import gzip
import io
import os
import sys
import tarfile


def tar_bytes(members, gz=True, extra=b""):
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w", format=tarfile.PAX_FORMAT) as t:
        for ti, data in members:
            t.addfile(ti, io.BytesIO(data) if data is not None else None)
    body = raw.getvalue()
    return gzip.compress(body, 6, mtime=0) + extra if gz else body


def reg(name, data=b"x", mode=0o644):
    ti = tarfile.TarInfo(name)
    ti.size, ti.mode = len(data), mode
    return ti, data


def dirm(name, mode=0o755):
    ti = tarfile.TarInfo(name)
    ti.type, ti.mode = tarfile.DIRTYPE, mode
    return ti, None


def sym(name, target):
    ti = tarfile.TarInfo(name)
    ti.type, ti.linkname, ti.mode = tarfile.SYMTYPE, target, 0o777
    return ti, None


def lnk(name, target):
    ti = tarfile.TarInfo(name)
    ti.type, ti.linkname, ti.mode = tarfile.LNKTYPE, target, 0o644
    return ti, None


def special(name, typ):
    ti = tarfile.TarInfo(name)
    ti.type, ti.mode = typ, 0o644
    return ti, None


CASES = {
    "ok-basic": ("ok", lambda: tar_bytes([dirm("sub"), reg("sub/a.txt"), reg("b.txt", b"hello"), sym("rel-link", "sub/a.txt"), sym("abs-link", "/data/elsewhere")])),
    "ok-vol": ("ok", lambda: tar_bytes([dirm("vol/"), reg("vol/file-1.txt"), dirm("vol/d"), reg("vol/d/x", b"y"), lnk("vol/hard", "vol/file-1.txt")])),
    "ok-dup-same-type": ("ok", lambda: tar_bytes([reg("a", b"1"), reg("a", b"22")])),
    "reject-dotdot": ("reject", lambda: tar_bytes([reg("../evil.txt")])),
    "reject-dotdot-mid": ("reject", lambda: tar_bytes([reg("a/../../evil.txt")])),
    "reject-absolute": ("reject", lambda: tar_bytes([reg("/etc/cron.d/evil")])),
    "reject-symlink-escape": ("reject", lambda: tar_bytes([sym("a", "/etc"), reg("a/passwd", b"root::0:0")])),
    "reject-symlink-rel-escape": ("reject", lambda: tar_bytes([sym("a", "../../.."), reg("a/x", b"x")])),
    "reject-hardlink-outside": ("reject", lambda: tar_bytes([lnk("steal", "/etc/passwd")])),
    "reject-hardlink-dotdot": ("reject", lambda: tar_bytes([lnk("steal", "../secret")])),
    "reject-hardlink-unseen": ("reject", lambda: tar_bytes([lnk("steal", "later"), reg("later")])),
    "reject-hardlink-to-symlink": ("reject", lambda: tar_bytes([sym("s", "/etc/passwd"), lnk("h", "s")])),
    "reject-chardev": ("reject", lambda: tar_bytes([special("dev/null", tarfile.CHRTYPE)])),
    "reject-blockdev": ("reject", lambda: tar_bytes([special("dev/sda", tarfile.BLKTYPE)])),
    "reject-fifo": ("reject", lambda: tar_bytes([special("pipe", tarfile.FIFOTYPE)])),
    "reject-setuid": ("reject", lambda: tar_bytes([reg("suid-shell", b"#!/bin/sh", 0o4755)])),
    "reject-setgid-dir": ("reject", lambda: tar_bytes([dirm("sgid", 0o2755)])),
    "reject-sticky": ("reject", lambda: tar_bytes([dirm("tmp", 0o1777)])),
    "reject-control-char": ("reject", lambda: tar_bytes([reg("bad\nname")])),
    "reject-long-name": ("reject", lambda: tar_bytes([reg("a" * 300)])),
    "reject-deep": ("reject", lambda: tar_bytes([reg("/".join(["d"] * 80) + "/f")])),
    "reject-type-change": ("reject", lambda: tar_bytes([dirm("x"), reg("x", b"now a file")])),
    "reject-outside-top": ("reject-top", lambda: tar_bytes([reg("vol/ok"), reg("other/file")])),
    "reject-trailing-garbage": ("reject", lambda: tar_bytes([reg("a")], extra=b"GARBAGE-AFTER-GZIP")),
    "reject-truncated-gzip": ("reject", lambda: tar_bytes([reg("a", os.urandom(4000))])[:-9]),
    "reject-not-gzip": ("reject", lambda: tar_bytes([reg("a")], gz=False)),
    "bomb": ("reject-bomb", lambda: tar_bytes([reg("zeros", b"\0" * (24 * 1024 * 1024))])),
    "many-entries": ("reject-entries", lambda: tar_bytes([reg(f"f{i}") for i in range(40)])),
}


def main(out):
    os.makedirs(out, exist_ok=True)
    for name, (verdict, build) in CASES.items():
        with open(os.path.join(out, f"{name}.tar.gz"), "wb") as f:
            f.write(build())
        print(name, verdict)


if __name__ == "__main__":
    main(sys.argv[1])
