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
import time
from pathlib import PurePosixPath

TMPFS_MAGIC = 0x01021994
VERSION_PATTERN = __import__('re').compile(r'^v[0-9]{8}-[0-9]{3}$')
BUNDLE_ID_PATTERN = __import__('re').compile(r'^[0-9a-f]{32}$')
REGISTRY_NAME_PATTERN = __import__('re').compile(r'^kinvest-v5\.candidates\.[A-Za-z0-9]+$')
BACKUP_NAME_PATTERN = __import__('re').compile(r'^[0-9A-Za-z._-]+\.sqlite$')
BACKUP_TEMP_PATTERN = __import__('re').compile(r'^\.backup-v5\.[A-Za-z0-9]+$')
RUNTIME_SOURCE_PATTERN = __import__('re').compile(
    r'^kinvest-v5\.(?:state(?:-[a-z]+)?|journal)\.[A-Za-z0-9]+$'
)
REGISTRY_FIELDS = {
    'accessId', 'ifindId', 'backupTemp', 'backupFinal', 'backupChecksum',
}
STATE_NAMES = {
    'current.state', 'previous.state', 'attempt.state',
    'deploy-v5.journal', 'deploy-v5-current.before',
}


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
        os.fstatvfs(fd)
        return 0
    value = LinuxStatFs()
    if ctypes.CDLL(None, use_errno=True).fstatfs(fd, ctypes.byref(value)) != 0:
        raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
    return int(value.f_type)


def tmpfs_matches(fd: int) -> bool:
    if statfs_fd(fd) == TMPFS_MAGIC:
        return True
    return os.geteuid() != 0 and os.environ.get('KINVEST_V5_TEST_ALLOW_NON_TMPFS') == '1'


def exact_directory(stat_value: os.stat_result, uid: int, gid: int, mode: int) -> bool:
    return stat.S_ISDIR(stat_value.st_mode) and stat_value.st_uid == uid and \
        stat_value.st_gid == gid and stat.S_IMODE(stat_value.st_mode) == mode


def write_all(fd: int, payload: bytes) -> None:
    view = memoryview(payload)
    while view:
        count = os.write(fd, view)
        if count <= 0:
            raise RuntimeErrorCode('DEPLOY_V5_DURABILITY_FAILED')
        view = view[count:]


def empty_registry() -> dict[str, str]:
    return {
        'accessId': 'none', 'ifindId': 'none', 'backupTemp': 'none',
        'backupFinal': 'none', 'backupChecksum': 'none',
    }


def validate_registry_value(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or set(value) != REGISTRY_FIELDS:
        raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
    for field in ('accessId', 'ifindId'):
        item = value[field]
        if item != 'none' and (not isinstance(item, str) or BUNDLE_ID_PATTERN.fullmatch(item) is None):
            raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
    temporary, final, checksum = value['backupTemp'], value['backupFinal'], value['backupChecksum']
    if temporary == final == checksum == 'none':
        return value
    if not isinstance(temporary, str) or BACKUP_TEMP_PATTERN.fullmatch(temporary) is None or \
            not isinstance(final, str) or BACKUP_NAME_PATTERN.fullmatch(final) is None or \
            not isinstance(checksum, str) or len(checksum) != 64 or \
            any(item not in '0123456789abcdef' for item in checksum):
        raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
    return value


def validate_journal_payload(payload: bytes, state_root: str) -> dict[str, object]:
    try:
        value = json.loads(payload)
    except (ValueError, TypeError, UnicodeDecodeError) as error:
        raise RuntimeErrorCode('DEPLOY_V5_JOURNAL_INVALID') from error
    fields = {
        'version', 'phase', 'intent', 'candidateAccessId', 'candidateIfindId',
        'pendingBackupPath', 'pendingBackupChecksum',
    }
    if not isinstance(value, dict) or set(value) != fields or value['version'] != 2 or \
            value['phase'] not in ('prepared', 'compose-active', 'state-committed') or \
            value['intent'] not in ('FORWARD', 'ROLLBACK', 'RESTORE'):
        raise RuntimeErrorCode('DEPLOY_V5_JOURNAL_INVALID')
    for field in ('candidateAccessId', 'candidateIfindId'):
        item = value[field]
        if item != 'none' and (not isinstance(item, str) or BUNDLE_ID_PATTERN.fullmatch(item) is None):
            raise RuntimeErrorCode('DEPLOY_V5_JOURNAL_INVALID')
    backup, checksum = value['pendingBackupPath'], value['pendingBackupChecksum']
    if backup == checksum == 'none':
        pass
    else:
        backup_root = PurePosixPath(state_root).parent / 'backups'
        candidate = PurePosixPath(backup) if isinstance(backup, str) else PurePosixPath('.')
        if not candidate.is_absolute() or candidate.parent != backup_root or \
                BACKUP_NAME_PATTERN.fullmatch(candidate.name) is None or \
                not isinstance(checksum, str) or len(checksum) != 64 or \
                any(item not in '0123456789abcdef' for item in checksum):
            raise RuntimeErrorCode('DEPLOY_V5_JOURNAL_INVALID')
    canonical = (json.dumps(value, separators=(',', ':'), sort_keys=True) + '\n').encode('ascii')
    if payload != canonical:
        raise RuntimeErrorCode('DEPLOY_V5_JOURNAL_INVALID')
    return value


def open_exact_directory(path: str, uid: int, gid: int, mode: int,
                         code: str, require_tmpfs: bool = False) -> int:
    if not os.path.isabs(path):
        raise RuntimeErrorCode(code)
    try:
        initial = os.lstat(path)
        fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError as error:
        raise RuntimeErrorCode(code) from error
    try:
        opened = os.fstat(fd)
        if (opened.st_dev, opened.st_ino) != (initial.st_dev, initial.st_ino) or \
                not exact_directory(opened, uid, gid, mode):
            raise RuntimeErrorCode(code)
        if require_tmpfs and not tmpfs_matches(fd):
            raise RuntimeErrorCode(code)
        return fd
    except BaseException:
        os.close(fd)
        raise


def fsync_parent(path: str, uid: int, gid: int, mode: int, code: str,
                 require_tmpfs: bool = False) -> None:
    fd = open_exact_directory(path, uid, gid, mode, code, require_tmpfs)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def fault_barrier(name: str) -> None:
    root = os.environ.get('KINVEST_V5_TEST_BARRIER_ROOT', '')
    selected = os.environ.get('KINVEST_V5_TEST_BARRIER', '')
    if not root or selected != name:
        return
    uid, gid = os.getuid(), os.getgid()
    root_fd = open_exact_directory(root, uid, gid, 0o700,
                                   'DEPLOY_V5_TEST_BARRIER_INVALID', True)
    try:
        marker = f'{name}.reached'
        fd = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=root_fd)
        try:
            write_all(fd, b'reached\n')
            os.fsync(fd)
        finally:
            os.close(fd)
        os.fsync(root_fd)
        while True:
            try:
                os.stat(f'{name}.release', dir_fd=root_fd, follow_symlinks=False)
                break
            except FileNotFoundError:
                time.sleep(0.01)
    finally:
        os.close(root_fd)


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
        if not tmpfs_matches(root_fd) or not tmpfs_matches(run_fd):
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


def write_registry(path: str, run_root: str, value: dict[str, str], uid: int, gid: int) -> None:
    if PurePosixPath(path).parent != PurePosixPath(run_root) or REGISTRY_NAME_PATTERN.fullmatch(PurePosixPath(path).name) is None:
        raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
    read_registry(path, run_root, uid, gid)
    temporary = f'{path}.tmp.{secrets.token_hex(8)}'
    fd = -1
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        os.fchmod(fd, 0o600)
        os.fchown(fd, uid, gid)
        payload = (json.dumps(value, separators=(',', ':'), sort_keys=True) + '\n').encode('ascii')
        write_all(fd, payload)
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(temporary, path)
        fault_barrier('registry-after-replace')
        fsync_parent(run_root, uid, gid, 0o755,
                     'DEPLOY_V5_CANDIDATE_REGISTRY_INVALID', True)
    finally:
        if fd >= 0: os.close(fd)
        try: os.unlink(temporary)
        except FileNotFoundError: pass


def read_registry(path: str, run_root: str, uid: int, gid: int) -> dict[str, str]:
    if PurePosixPath(path).parent != PurePosixPath(run_root) or REGISTRY_NAME_PATTERN.fullmatch(PurePosixPath(path).name) is None:
        raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID') from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o600:
            raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
        raw = os.read(fd, 513)
        if len(raw) > 512: raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
        return validate_registry_value(json.loads(raw))
    except (OSError, ValueError, TypeError) as error:
        raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID') from error
    finally:
        os.close(fd)


def reserve_registry(run_root: str, uid: int, gid: int) -> str:
    root_fd = open_exact_directory(run_root, uid, gid, 0o755,
                                   'DEPLOY_V5_CANDIDATE_REGISTRY_INVALID', True)
    try:
        fault_barrier('registry-before-create')
        for _ in range(128):
            name = f'kinvest-v5.candidates.{secrets.token_hex(12)}'
            try:
                fd = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                             0o600, dir_fd=root_fd)
            except FileExistsError:
                continue
            try:
                os.fchmod(fd, 0o600)
                os.fchown(fd, uid, gid)
                fault_barrier('registry-after-create-zero')
                payload = (json.dumps(empty_registry(), separators=(',', ':'), sort_keys=True) + '\n').encode('ascii')
                write_all(fd, payload)
                os.fsync(fd)
            finally:
                os.close(fd)
            os.fsync(root_fd)
            return os.path.join(run_root, name)
    except BaseException:
        raise
    finally:
        os.close(root_fd)
    raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_FAILED')


def validate_runtime_source(path: str, run_root: str, uid: int, gid: int) -> tuple[int, int]:
    candidate = PurePosixPath(path)
    if candidate.parent != PurePosixPath(run_root) or \
            RUNTIME_SOURCE_PATTERN.fullmatch(candidate.name) is None:
        raise RuntimeErrorCode('DEPLOY_V5_RUNTIME_SOURCE_INVALID')
    root_fd = open_exact_directory(run_root, uid, gid, 0o755,
                                   'DEPLOY_V5_RUNTIME_SOURCE_INVALID', True)
    try:
        fd = os.open(candidate.name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
    except OSError as error:
        os.close(root_fd)
        raise RuntimeErrorCode('DEPLOY_V5_RUNTIME_SOURCE_INVALID') from error
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or \
            info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(fd)
        os.close(root_fd)
        raise RuntimeErrorCode('DEPLOY_V5_RUNTIME_SOURCE_INVALID')
    return root_fd, fd


def remove_runtime_source(path: str, run_root: str, uid: int, gid: int) -> None:
    root_fd, fd = validate_runtime_source(path, run_root, uid, gid)
    try:
        name = PurePosixPath(path).name
        opened = os.fstat(fd)
        current = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        if (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino):
            raise RuntimeErrorCode('DEPLOY_V5_RUNTIME_SOURCE_INVALID')
        os.unlink(name, dir_fd=root_fd)
        os.fsync(root_fd)
    finally:
        os.close(fd)
        os.close(root_fd)


def cleanup_stale_sources(run_root: str, uid: int, gid: int) -> None:
    root_fd = open_exact_directory(run_root, uid, gid, 0o755,
                                   'DEPLOY_V5_RUNTIME_SOURCE_INVALID', True)
    os.close(root_fd)
    for name in os.listdir(run_root):
        if RUNTIME_SOURCE_PATTERN.fullmatch(name) is None:
            continue
        remove_runtime_source(os.path.join(run_root, name), run_root, uid, gid)


def build_journal_source(path: str, run_root: str, state_root: str, phase: str,
                         intent: str, access_id: str, ifind_id: str,
                         backup_path: str, backup_checksum: str,
                         uid: int, gid: int) -> None:
    value = {
        'version': 2, 'phase': phase, 'intent': intent,
        'candidateAccessId': access_id, 'candidateIfindId': ifind_id,
        'pendingBackupPath': backup_path, 'pendingBackupChecksum': backup_checksum,
    }
    payload = (json.dumps(value, separators=(',', ':'), sort_keys=True) + '\n').encode('ascii')
    validate_journal_payload(payload, state_root)
    root_fd, existing_fd = validate_runtime_source(path, run_root, uid, gid)
    os.close(existing_fd)
    name = PurePosixPath(path).name
    try:
        fd = os.open(name, os.O_WRONLY | os.O_TRUNC | os.O_NOFOLLOW, dir_fd=root_fd)
        try:
            write_all(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
    finally:
        os.close(root_fd)


def durable_state_write(state_root: str, target_name: str, payload: bytes,
                        uid: int, gid: int) -> None:
    if target_name not in STATE_NAMES:
        raise RuntimeErrorCode('DEPLOY_V5_STATE_WRITE_FAILED')
    if target_name == 'deploy-v5.journal':
        validate_journal_payload(payload, state_root)
    root_fd = open_exact_directory(state_root, uid, gid, 0o700,
                                   'DEPLOY_V5_STATE_WRITE_FAILED')
    temporary = f'.{target_name}.{secrets.token_hex(12)}'
    fd = -1
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                     0o600, dir_fd=root_fd)
        os.fchmod(fd, 0o600)
        os.fchown(fd, uid, gid)
        write_all(fd, payload)
        os.fsync(fd)
        os.close(fd)
        fd = -1
        if os.environ.get('FAKE_FAILURE') == 'state-mv' and target_name == 'attempt.state':
            raise RuntimeErrorCode('DEPLOY_V5_STATE_WRITE_FAILED')
        os.replace(temporary, target_name, src_dir_fd=root_fd, dst_dir_fd=root_fd)
        if target_name == 'deploy-v5.journal':
            fault_barrier('journal-after-rename')
        elif target_name == 'current.state':
            fault_barrier('current-after-rename')
        os.fsync(root_fd)
    except BaseException:
        try:
            os.unlink(temporary, dir_fd=root_fd)
        except FileNotFoundError:
            pass
        raise
    finally:
        if fd >= 0:
            os.close(fd)
        os.close(root_fd)


def durable_state_delete(state_root: str, names: list[str], uid: int, gid: int) -> None:
    if not names or any(name not in STATE_NAMES for name in names):
        raise RuntimeErrorCode('DEPLOY_V5_STATE_WRITE_FAILED')
    root_fd = open_exact_directory(state_root, uid, gid, 0o700,
                                   'DEPLOY_V5_STATE_WRITE_FAILED')
    try:
        if os.environ.get('FAKE_RM_FAILURE') == 'journal-rm' and 'deploy-v5.journal' in names:
            raise RuntimeErrorCode('DEPLOY_V5_STATE_WRITE_FAILED')
        for name in names:
            try:
                os.unlink(name, dir_fd=root_fd)
            except FileNotFoundError:
                continue
        os.fsync(root_fd)
    finally:
        os.close(root_fd)


def read_regular_file(path: str, maximum: int, code: str) -> bytes:
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    except OSError as error:
        raise RuntimeErrorCode(code) from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > maximum:
            raise RuntimeErrorCode(code)
        chunks = []
        remaining = maximum + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        value = b''.join(chunks)
        if len(value) > maximum:
            raise RuntimeErrorCode(code)
        return value
    finally:
        os.close(fd)


def open_backup_root(root: str, uid: int, gid: int) -> int:
    return open_exact_directory(root, uid, gid, 0o700, 'DEPLOY_V5_BACKUP_INVALID')


def validate_backup_temp(root_fd: int, root: str, path: str, uid: int, gid: int) -> tuple[int, str]:
    if not os.path.isabs(path) or PurePosixPath(path).parent != PurePosixPath(root):
        raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
    name = PurePosixPath(path).name
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
    except OSError as error:
        raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID') from error
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or \
            info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o600:
        os.close(fd)
        raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
    return fd, name


def commit_backup_no_replace(root: str, temporary: str, desired_name: str,
                             uid: int, gid: int, registry_path: str | None = None,
                             run_root: str | None = None) -> str:
    if BACKUP_NAME_PATTERN.fullmatch(desired_name) is None:
        raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
    root_fd = open_backup_root(root, uid, gid)
    source_fd = -1
    registry_recorded = False
    source_name = ''
    try:
        source_fd, source_name = validate_backup_temp(root_fd, root, temporary, uid, gid)
        os.fsync(source_fd)
        checksum = hashlib.file_digest(os.fdopen(os.dup(source_fd), 'rb'), 'sha256').hexdigest()
        if os.environ.get('FAKE_FAILURE') == 'backup-mv':
            raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
        for attempt in range(128):
            candidate = desired_name if attempt == 0 else \
                f'{desired_name[:-7]}.{secrets.token_hex(8)}.sqlite'
            if registry_path is not None and run_root is not None:
                registry = read_registry(registry_path, run_root, uid, gid)
                registry.update({
                    'backupTemp': source_name, 'backupFinal': candidate,
                    'backupChecksum': checksum,
                })
                try:
                    write_registry(registry_path, run_root, registry, uid, gid)
                    registry_recorded = True
                except BaseException:
                    if not registry_recorded:
                        try:
                            persisted = read_registry(registry_path, run_root, uid, gid)
                            registry_recorded = persisted['backupTemp'] == source_name and \
                                persisted['backupChecksum'] == checksum
                        except Exception:
                            registry_recorded = False
                    raise
            fault_barrier('backup-before-link')
            try:
                os.link(source_name, candidate, src_dir_fd=root_fd,
                        dst_dir_fd=root_fd, follow_symlinks=False)
                fault_barrier('backup-after-link')
                os.fsync(root_fd)
                os.unlink(source_name, dir_fd=root_fd)
                os.fsync(root_fd)
                fault_barrier('backup-after-unlink')
                return os.path.join(root, candidate)
            except FileExistsError:
                continue
        raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
    except BaseException:
        if not registry_recorded and source_fd >= 0 and source_name:
            try:
                opened = os.fstat(source_fd)
                current = os.stat(source_name, dir_fd=root_fd, follow_symlinks=False)
                if (opened.st_dev, opened.st_ino) == (current.st_dev, current.st_ino):
                    os.unlink(source_name, dir_fd=root_fd)
                    os.fsync(root_fd)
            except OSError:
                pass
        raise
    finally:
        if source_fd >= 0:
            os.close(source_fd)
        os.close(root_fd)


def verify_backup(path: str, expected: str, root: str, uid: int, gid: int) -> None:
    if len(expected) != 64 or any(value not in '0123456789abcdef' for value in expected):
        raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
    root_fd = open_backup_root(root, uid, gid)
    file_fd = -1
    try:
        file_fd, _ = validate_backup_temp(root_fd, root, path, uid, gid)
        digest = hashlib.file_digest(os.fdopen(os.dup(file_fd), 'rb'), 'sha256').hexdigest()
        if digest != expected:
            raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        os.close(root_fd)


def read_secure_bytes(root_fd: int, name: str, uid: int, gid: int,
                      code: str) -> bytes | None:
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise RuntimeErrorCode(code) from error
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != uid or \
                info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > 1024 * 1024:
            raise RuntimeErrorCode(code)
        return os.read(fd, info.st_size + 1)
    except OSError as error:
        raise RuntimeErrorCode(code) from error
    finally:
        os.close(fd)


def read_secure_json(root_fd: int, name: str, uid: int, gid: int,
                     code: str) -> dict[str, object] | None:
    raw = read_secure_bytes(root_fd, name, uid, gid, code)
    if raw is None:
        return None
    try:
        value = json.loads(raw)
    except (ValueError, TypeError, UnicodeDecodeError) as error:
        raise RuntimeErrorCode(code) from error
    if not isinstance(value, dict):
        raise RuntimeErrorCode(code)
    return value


def read_secure_state_fields(root_fd: int, name: str, uid: int, gid: int,
                             code: str) -> dict[str, str] | None:
    raw = read_secure_bytes(root_fd, name, uid, gid, code)
    if raw is None:
        return None
    try:
        text = raw.decode('ascii')
        fields: dict[str, str] = {}
        for line in text.splitlines():
            key, separator, value = line.partition('=')
            if not separator or not key or key in fields:
                raise RuntimeErrorCode(code)
            fields[key] = value
        return fields
    except UnicodeDecodeError as error:
        raise RuntimeErrorCode(code) from error


def collect_backup_references(state_root: str, backup_root: str,
                              uid: int, gid: int) -> dict[str, str]:
    root_fd = open_exact_directory(state_root, uid, gid, 0o700,
                                   'DEPLOY_V5_BACKUP_REFERENCE_INVALID')
    references: dict[str, str] = {}
    try:
        for name in ('current.state', 'previous.state', 'attempt.state'):
            value = read_secure_state_fields(root_fd, name, uid, gid,
                                             'DEPLOY_V5_BACKUP_REFERENCE_INVALID')
            if value is None:
                continue
            if 'databaseBackupPath' not in value or 'databaseBackupChecksum' not in value:
                raise RuntimeErrorCode('DEPLOY_V5_BACKUP_REFERENCE_INVALID')
            path = value['databaseBackupPath']
            checksum = value['databaseBackupChecksum']
            if path == checksum == 'none':
                continue
            candidate = PurePosixPath(path) if isinstance(path, str) else PurePosixPath('.')
            if candidate.parent != PurePosixPath(backup_root) or \
                    BACKUP_NAME_PATTERN.fullmatch(candidate.name) is None or \
                    not isinstance(checksum, str) or len(checksum) != 64 or \
                    any(character not in '0123456789abcdef' for character in checksum):
                raise RuntimeErrorCode('DEPLOY_V5_BACKUP_REFERENCE_INVALID')
            if str(candidate) in references and references[str(candidate)] != checksum:
                raise RuntimeErrorCode('DEPLOY_V5_BACKUP_REFERENCE_INVALID')
            references[str(candidate)] = checksum
        journal_raw = read_secure_bytes(root_fd, 'deploy-v5.journal', uid, gid,
                                        'DEPLOY_V5_BACKUP_REFERENCE_INVALID')
        if journal_raw is not None:
            validated = validate_journal_payload(journal_raw, state_root)
            path = validated['pendingBackupPath']
            checksum = validated['pendingBackupChecksum']
            if path != 'none':
                if str(path) in references and references[str(path)] != str(checksum):
                    raise RuntimeErrorCode('DEPLOY_V5_BACKUP_REFERENCE_INVALID')
                references[str(path)] = str(checksum)
    finally:
        os.close(root_fd)
    for path, checksum in references.items():
        verify_backup(path, checksum, backup_root, uid, gid)
    return references


def unlink_backup_entry(root_fd: int, name: str) -> None:
    os.unlink(name, dir_fd=root_fd)
    os.fsync(root_fd)


def recover_registered_backup(value: dict[str, str], backup_root: str,
                              state_root: str, uid: int, gid: int) -> None:
    temporary, final, checksum = value['backupTemp'], value['backupFinal'], value['backupChecksum']
    if temporary == final == checksum == 'none':
        return
    references = collect_backup_references(state_root, backup_root, uid, gid)
    root_fd = open_backup_root(backup_root, uid, gid)
    try:
        entries: dict[str, tuple[int, os.stat_result]] = {}
        for name, pattern in ((temporary, BACKUP_TEMP_PATTERN), (final, BACKUP_NAME_PATTERN)):
            if pattern.fullmatch(name) is None:
                raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
            try:
                fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=root_fd)
            except FileNotFoundError:
                continue
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != uid or info.st_gid != gid or \
                    stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink not in (1, 2):
                os.close(fd)
                raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
            digest = hashlib.file_digest(os.fdopen(os.dup(fd), 'rb'), 'sha256').hexdigest()
            if digest != checksum:
                os.close(fd)
                if name == final:
                    continue
                raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
            entries[name] = (fd, info)
        preexisting_same_content_final = False
        if temporary in entries and final in entries:
            left, right = entries[temporary][1], entries[final][1]
            if (left.st_dev, left.st_ino) != (right.st_dev, right.st_ino):
                preexisting_same_content_final = True
            elif left.st_nlink != 2:
                raise RuntimeErrorCode('DEPLOY_V5_BACKUP_INVALID')
        final_path = os.path.join(backup_root, final)
        keep_final = references.get(final_path) == checksum
        if temporary in entries:
            unlink_backup_entry(root_fd, temporary)
        if final in entries and not keep_final and not preexisting_same_content_final:
            unlink_backup_entry(root_fd, final)
        if keep_final:
            verify_backup(final_path, checksum, backup_root, uid, gid)
    finally:
        for fd, _ in locals().get('entries', {}).values():
            os.close(fd)
        os.close(root_fd)


def recover_orphan_backups(backup_root: str, state_root: str, uid: int, gid: int) -> None:
    # Unknown .sqlite files may be historical or manually managed backups. Only
    # registry recovery owns transaction artifacts; this pass validates every
    # durable reference as one complete plan and deliberately deletes nothing.
    collect_backup_references(state_root, backup_root, uid, gid)


def create_candidate(root_fd: int, uid: int, gid: int, registry_path: str,
                     run_root: str, registry: dict[str, str], field: str,
                     registry_uid: int, registry_gid: int) -> tuple[str, int]:
    bundle_id = secrets.token_hex(16)
    candidate_fd = -1
    registry[field] = bundle_id
    write_registry(registry_path, run_root, registry, registry_uid, registry_gid)
    try:
        os.mkdir(bundle_id, 0o700, dir_fd=root_fd)
        # CREATE_CANDIDATE_AFTER_MKDIR
        candidate_fd = os.open(bundle_id, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root_fd)
        # CREATE_CANDIDATE_AFTER_OPEN
        os.fchmod(candidate_fd, 0o700)
        os.fchown(candidate_fd, uid, gid)
        # CREATE_CANDIDATE_AFTER_CHOWN
        candidate = os.fstat(candidate_fd)
        root = os.fstat(root_fd)
        if not exact_directory(candidate, uid, gid, 0o700) or candidate.st_dev != root.st_dev:
            raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
        if not tmpfs_matches(candidate_fd):
            raise RuntimeErrorCode('DEPLOY_V5_TMPFS_INVALID')
        # CREATE_CANDIDATE_AFTER_STATFS
        return bundle_id, candidate_fd
    except BaseException:
        if candidate_fd >= 0: os.close(candidate_fd)
        remove_candidate(root_fd, bundle_id)
        registry[field] = 'none'
        write_registry(registry_path, run_root, registry, registry_uid, registry_gid)
        raise


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
                bundle_uid: int, bundle_gid: int, root_uid: int, root_gid: int,
                registry_path: str) -> dict[str, str]:
    access_fd = validate_tmpfs_bundle_root(access_root, run_root, root_uid, root_gid)
    ifind_fd = validate_tmpfs_bundle_root(ifind_root, run_root, root_uid, root_gid)
    created: list[tuple[int, str]] = []
    owned: list[bytearray] = []
    registry = empty_registry()
    write_registry(registry_path, run_root, registry, root_uid, root_gid)
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
            access_id, candidate_fd = create_candidate(
                access_fd, bundle_uid, bundle_gid, registry_path, run_root,
                registry, 'accessId', root_uid, root_gid,
            )
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
            ifind_id, candidate_fd = create_candidate(
                ifind_fd, bundle_uid, bundle_gid, registry_path, run_root,
                registry, 'ifindId', root_uid, root_gid,
            )
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
        try:
            current = read_registry(registry_path, run_root, root_uid, root_gid)
            remove_candidate(access_fd, current['accessId'])
            remove_candidate(ifind_fd, current['ifindId'])
            os.unlink(registry_path)
        except Exception:
            pass
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


def recover_registry(registry_path: str, run_root: str, access_root: str,
                     ifind_root: str, backup_root: str, state_root: str,
                     root_uid: int, root_gid: int) -> None:
    if PurePosixPath(registry_path).parent != PurePosixPath(run_root) or \
            REGISTRY_NAME_PATTERN.fullmatch(PurePosixPath(registry_path).name) is None:
        raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
    access_fd = validate_tmpfs_bundle_root(access_root, run_root, root_uid, root_gid)
    ifind_fd = validate_tmpfs_bundle_root(ifind_root, run_root, root_uid, root_gid)
    try:
        try:
            registry_fd = os.open(registry_path, os.O_RDONLY | os.O_NOFOLLOW)
        except OSError as error:
            raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID') from error
        try:
            info = os.fstat(registry_fd)
            empty = info.st_size == 0
            if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or \
                    info.st_uid != root_uid or info.st_gid != root_gid or \
                    stat.S_IMODE(info.st_mode) != 0o600:
                raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
        finally:
            os.close(registry_fd)
        if empty:
            os.unlink(registry_path)
            fsync_parent(run_root, root_uid, root_gid, 0o755,
                         'DEPLOY_V5_CANDIDATE_REGISTRY_INVALID', True)
            return
        value = read_registry(registry_path, run_root, root_uid, root_gid)
        remove_candidate(access_fd, value['accessId'])
        remove_candidate(ifind_fd, value['ifindId'])
        recover_registered_backup(value, backup_root, state_root, root_uid, root_gid)
        os.unlink(registry_path)
        fsync_parent(run_root, root_uid, root_gid, 0o755,
                     'DEPLOY_V5_CANDIDATE_REGISTRY_INVALID', True)
    finally:
        os.close(access_fd)
        os.close(ifind_fd)


def release_registry(registry_path: str, run_root: str, state_root: str,
                     backup_root: str, root_uid: int, root_gid: int) -> None:
    value = read_registry(registry_path, run_root, root_uid, root_gid)
    if value['backupFinal'] != 'none':
        references = collect_backup_references(state_root, backup_root, root_uid, root_gid)
        final_path = os.path.join(backup_root, value['backupFinal'])
        if references.get(final_path) != value['backupChecksum']:
            raise RuntimeErrorCode('DEPLOY_V5_CANDIDATE_REGISTRY_INVALID')
    os.unlink(registry_path)
    fsync_parent(run_root, root_uid, root_gid, 0o755,
                 'DEPLOY_V5_CANDIDATE_REGISTRY_INVALID', True)


def main() -> int:
    def interrupted(_signum: int, _frame: object) -> None:
        raise RuntimeErrorCode('DEPLOY_V5_RUNTIME_INTERRUPTED')

    for signum in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(signum, interrupted)
    if len(sys.argv) == 5 and sys.argv[1] == 'reserve-registry':
        print(reserve_registry(sys.argv[2], int(sys.argv[3]), int(sys.argv[4])))
    elif len(sys.argv) == 11 and sys.argv[1] == 'materialize':
        result = materialize(
            sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
            int(sys.argv[6]), int(sys.argv[7]), int(sys.argv[8]), int(sys.argv[9]),
            sys.argv[10],
        )
        print(json.dumps(result, separators=(',', ':'), sort_keys=True))
    elif len(sys.argv) == 10 and sys.argv[1] == 'recover':
        recover_registry(
            sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
            sys.argv[6], sys.argv[7], int(sys.argv[8]), int(sys.argv[9]),
        )
    elif len(sys.argv) == 8 and sys.argv[1] == 'release-registry':
        release_registry(sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5],
                         int(sys.argv[6]), int(sys.argv[7]))
    elif len(sys.argv) == 5 and sys.argv[1] == 'cleanup-stale-sources':
        cleanup_stale_sources(sys.argv[2], int(sys.argv[3]), int(sys.argv[4]))
    elif len(sys.argv) == 6 and sys.argv[1] == 'remove-runtime-source':
        remove_runtime_source(sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5]))
    elif len(sys.argv) == 13 and sys.argv[1] == 'build-journal-source':
        build_journal_source(
            sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5], sys.argv[6],
            sys.argv[7], sys.argv[8], sys.argv[9], sys.argv[10],
            int(sys.argv[11]), int(sys.argv[12]),
        )
    elif len(sys.argv) == 7 and sys.argv[1] == 'state-write':
        payload = read_regular_file(sys.argv[4], 1024 * 1024, 'DEPLOY_V5_STATE_WRITE_FAILED')
        durable_state_write(sys.argv[2], sys.argv[3], payload,
                            int(sys.argv[5]), int(sys.argv[6]))
    elif len(sys.argv) >= 6 and sys.argv[1] == 'state-delete':
        durable_state_delete(sys.argv[2], sys.argv[5:], int(sys.argv[3]), int(sys.argv[4]))
    elif len(sys.argv) == 9 and sys.argv[1] == 'commit-backup':
        print(commit_backup_no_replace(sys.argv[2], sys.argv[3], sys.argv[4],
                                       int(sys.argv[5]), int(sys.argv[6]),
                                       sys.argv[7], sys.argv[8]))
    elif len(sys.argv) == 7 and sys.argv[1] == 'verify-backup':
        verify_backup(sys.argv[2], sys.argv[3], sys.argv[4],
                      int(sys.argv[5]), int(sys.argv[6]))
    elif len(sys.argv) == 6 and sys.argv[1] == 'recover-orphan-backups':
        recover_orphan_backups(sys.argv[2], sys.argv[3],
                               int(sys.argv[4]), int(sys.argv[5]))
    else:
        raise RuntimeErrorCode('DEPLOY_V5_RUNTIME_USAGE')
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        # Never expose traceback, payload, paths, or secret material.
        sys.stderr.write('DEPLOY_V5_RUNTIME_FAILED\n')
        raise SystemExit(1)
