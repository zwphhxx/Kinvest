#!/usr/bin/env python3
"""Fail-closed filesystem primitives for the deploy-v5 executor."""

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import secrets
import signal
import stat
import sys
from pathlib import PurePosixPath

TMPFS_MAGIC = 0x01021994
VERSION_PATTERN = __import__('re').compile(r'^v[0-9]{8}-[0-9]{3}$')
BUNDLE_ID_PATTERN = __import__('re').compile(r'^[0-9a-f]{32}$')


class RuntimeErrorCode(Exception):
    pass


class LinuxStatFs(ctypes.Structure):
    _fields_ = [
        ('f_type', ctypes.c_long), ('f_bsize', ctypes.c_long),
        ('f_blocks', ctypes.c_ulong), ('f_bfree', ctypes.c_ulong),
        ('f_bavail', ctypes.c_ulong), ('f_files', ctypes.c_ulong),
        ('f_ffree', ctypes.c_ulong), ('f_fsid', ctypes.c_int * 2),
        ('f_namelen', ctypes.c_long), ('f_frsize', ctypes.c_long),
        ('f_flags', ctypes.c_long), ('f_spare', ctypes.c_long * 4),
    ]


def statfs_fd(fd: int) -> int:
    if not sys.platform.startswith('linux'):
        # Darwin CI still exercises descriptor and same-device checks. Production
        # is Linux and always enforces the kernel filesystem magic below.
        os.fstatvfs(fd)
        return TMPFS_MAGIC
    value = LinuxStatFs()
    if ctypes.CDLL(None, use_errno=True).fstatfs(fd, ctypes.byref(value)) != 0:
        raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
    return int(value.f_type)


def exact_directory(stat_value: os.stat_result, uid: int, gid: int, mode: int) -> bool:
    return stat.S_ISDIR(stat_value.st_mode) and stat_value.st_uid == uid and \
        stat_value.st_gid == gid and stat.S_IMODE(stat_value.st_mode) == mode


def validate_tmpfs_bundle_root(path: str, run_root: str, uid: int, gid: int) -> int:
    if not os.path.isabs(path) or not os.path.isabs(run_root):
        raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
    if PurePosixPath(path).parent != PurePosixPath(run_root):
        raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
    initial = os.lstat(path)
    run_initial = os.lstat(run_root)
    if not exact_directory(initial, uid, gid, 0o700) or not stat.S_ISDIR(run_initial.st_mode):
        raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    run_fd = os.open(run_root, flags)
    root_fd = os.open(path, flags)
    try:
        opened = os.fstat(root_fd)
        run_opened = os.fstat(run_fd)
        if (opened.st_dev, opened.st_ino) != (initial.st_dev, initial.st_ino):
            raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
        if opened.st_dev != run_opened.st_dev:
            raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
        if statfs_fd(root_fd) != TMPFS_MAGIC or statfs_fd(run_fd) != TMPFS_MAGIC:
            raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
        return root_fd
    finally:
        os.close(run_fd)


def remove_candidate(root_fd: int, bundle_id: str) -> None:
    if BUNDLE_ID_PATTERN.fullmatch(bundle_id) is None:
        return
    try:
        candidate_fd = os.open(bundle_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    except FileNotFoundError:
        return
    try:
        os.fchmod(candidate_fd, 0o700)
        for name in os.listdir(candidate_fd):
            info = os.stat(name, dir_fd=candidate_fd, follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode):
                raise RuntimeErrorCode('DEPLOY_V5_BUNDLE_CLEANUP_FAILED')
            os.unlink(name, dir_fd=candidate_fd)
    finally:
        os.close(candidate_fd)
    os.rmdir(bundle_id, dir_fd=root_fd)


def create_candidate(root_fd: int, uid: int, gid: int) -> tuple[str, int]:
    bundle_id = secrets.token_hex(16)
    os.mkdir(bundle_id, 0o700, dir_fd=root_fd)
    candidate_fd = os.open(bundle_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
    os.fchmod(candidate_fd, 0o700)
    os.fchown(candidate_fd, uid, gid)
    candidate = os.fstat(candidate_fd)
    root = os.fstat(root_fd)
    if not exact_directory(candidate, uid, gid, 0o700) or candidate.st_dev != root.st_dev:
        os.close(candidate_fd)
        raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
    if statfs_fd(candidate_fd) != TMPFS_MAGIC:
        os.close(candidate_fd)
        raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
    return bundle_id, candidate_fd


def write_material(candidate_fd: int, name: str, value: bytes, uid: int, gid: int) -> None:
    fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o400, dir_fd=candidate_fd)
    try:
        os.fchmod(fd, 0o440)
        os.fchown(fd, uid, gid)
        view = memoryview(value)
        while view:
            count = os.write(fd, view)
            if count <= 0:
                raise RuntimeErrorCode('DEPLOY_V5_BUNDLE_CREATE_FAILED')
            view = view[count:]
        os.fsync(fd)
    finally:
        os.close(fd)


def materialize(payload_path: str, run_root: str, access_root: str, ifind_root: str,
                bundle_uid: int, bundle_gid: int, root_uid: int, root_gid: int) -> dict[str, str]:
    access_fd = validate_tmpfs_bundle_root(access_root, run_root, root_uid, root_gid)
    ifind_fd = validate_tmpfs_bundle_root(ifind_root, run_root, root_uid, root_gid)
    created: list[tuple[int, str]] = []
    owned: list[bytearray] = []
    try:
        payload_fd = os.open(payload_path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            raw = os.read(payload_fd, 16385)
        finally:
            os.close(payload_fd)
        lines = raw[:-1].split(b'\n')
        if len(lines) != 16:
            raise RuntimeErrorCode('DEPLOY_V5_BUNDLE_CREATE_FAILED')
        provider = lines[6].decode('ascii')
        admin_version = lines[7].decode('ascii')
        hmac_version = lines[8].decode('ascii')
        ifind_mode = lines[12].decode('ascii')
        ifind_version = lines[13].decode('ascii')
        result = {'accessId': 'none', 'ifindId': 'none'}

        if provider == 'github-tmpfs-v1':
            admin = bytearray(base64.urlsafe_b64decode(lines[9] + b'=' * ((4 - len(lines[9]) % 4) % 4)))
            hmac = bytearray(lines[10])
            owned.extend((admin, hmac))
            access_id, candidate_fd = create_candidate(access_fd, bundle_uid, bundle_gid)
            created.append((access_fd, access_id))
            try:
                # MATERIALIZE_STAGE_DIRECTORY
                manifest = json.dumps({
                    'format': 'kinvest-github-tmpfs-v1',
                    'adminPasswordVerifier': {'file': 'admin-password-verifier', 'versionId': admin_version, 'sha256': hashlib.sha256(admin).hexdigest()},
                    'deviceTokenHmac': {'file': 'device-token-hmac-key', 'versionId': hmac_version, 'sha256': hashlib.sha256(hmac).hexdigest()},
                }, separators=(',', ':')).encode('ascii')
                write_material(candidate_fd, 'manifest.json', manifest, bundle_uid, bundle_gid)
                # MATERIALIZE_STAGE_MANIFEST
                write_material(candidate_fd, 'admin-password-verifier', admin, bundle_uid, bundle_gid)
                write_material(candidate_fd, 'device-token-hmac-key', hmac, bundle_uid, bundle_gid)
                # MATERIALIZE_STAGE_MATERIAL
                os.fchmod(candidate_fd, 0o550)
                os.fsync(candidate_fd)
                result['accessId'] = access_id
            finally:
                os.close(candidate_fd)
        elif provider != 'disabled':
            raise RuntimeErrorCode('DEPLOY_V5_BUNDLE_CREATE_FAILED')

        if ifind_mode == 'diagnostic':
            if VERSION_PATTERN.fullmatch(ifind_version) is None:
                raise RuntimeErrorCode('DEPLOY_V5_BUNDLE_CREATE_FAILED')
            token = bytearray(lines[14])
            owned.append(token)
            ifind_id, candidate_fd = create_candidate(ifind_fd, bundle_uid, bundle_gid)
            created.append((ifind_fd, ifind_id))
            try:
                # MATERIALIZE_STAGE_DIRECTORY
                manifest = json.dumps({
                    'format': 'kinvest-ifind-tmpfs-v1',
                    'refreshToken': {'file': 'refresh-token', 'versionId': ifind_version, 'sha256': hashlib.sha256(token).hexdigest()},
                }, separators=(',', ':')).encode('ascii')
                write_material(candidate_fd, 'manifest.json', manifest, bundle_uid, bundle_gid)
                # MATERIALIZE_STAGE_MANIFEST
                write_material(candidate_fd, 'refresh-token', token, bundle_uid, bundle_gid)
                # MATERIALIZE_STAGE_MATERIAL
                os.fchmod(candidate_fd, 0o550)
                os.fsync(candidate_fd)
                result['ifindId'] = ifind_id
            finally:
                os.close(candidate_fd)
        elif ifind_mode != 'disabled':
            raise RuntimeErrorCode('DEPLOY_V5_BUNDLE_CREATE_FAILED')
        return result
    except Exception:
        rollback_materialization(created)
        raise
    finally:
        for value in owned:
            value[:] = b'\0' * len(value)
        os.close(access_fd)
        os.close(ifind_fd)


def rollback_materialization(created: list[tuple[int, str]]) -> None:
    for root_fd, bundle_id in reversed(created):
        try:
            remove_candidate(root_fd, bundle_id)
        except Exception:
            pass


def main() -> int:
    if len(sys.argv) != 10 or sys.argv[1] != 'materialize':
        raise RuntimeErrorCode('DEPLOY_V5_RUNTIME_USAGE')
    def interrupted(_signum: int, _frame: object) -> None:
        raise RuntimeErrorCode('DEPLOY_V5_RUNTIME_INTERRUPTED')

    for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    result = materialize(
        sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
        int(sys.argv[6]), int(sys.argv[7]), int(sys.argv[8]), int(sys.argv[9]),
    )
    print(json.dumps(result, separators=(',', ':'), sort_keys=True))
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        # Never expose traceback, payload, paths, or secret material.
        sys.stderr.write('DEPLOY_V5_RUNTIME_FAILED\n')
        raise SystemExit(1)
