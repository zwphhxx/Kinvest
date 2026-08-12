#!/usr/bin/env python3
"""Bounded verification for Kinvest offline Docker/OCI archives."""

from __future__ import annotations

import contextlib
import dataclasses
import datetime
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import tempfile
from typing import Any, BinaryIO


ALLOWED_SOURCE = re.compile(
    r"^ghcr\.io/zwphhxx/kinvest@sha256:[0-9a-f]{64}$"
)
SHA256 = re.compile(r"^[0-9a-f]{64}$")
BLOB_PATH = re.compile(r"^blobs/sha256/([0-9a-f]{64})$")
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBERS = 4096
MAX_JSON_BYTES = 1024 * 1024
MAX_CAPTURED_METADATA_BYTES = 16 * 1024 * 1024
MAX_DESCRIPTOR_DEPTH = 8
SOURCE_ANNOTATION = "containerd.io/distribution.source.ghcr.io"
SOURCE_ANNOTATION_VALUE = "zwphhxx/kinvest"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
DEFAULT_STATE_DIR = Path("/root/docker/kinvest/state/offline-images")
IMAGE_ID = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
RUN_ID = re.compile(r"^[0-9]+$")
RFC3339_UTC = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
)
RECORD_FIELDS = (
    "version",
    "sourceDigest",
    "platform",
    "platformManifestDigest",
    "runtimeImageId",
    "archiveSha256",
    "commit",
    "verificationRunId",
    "importedAt",
)
DOCKER_LOAD_TIMEOUT_SECONDS = 120
DOCKER_INSPECT_TIMEOUT_SECONDS = 10
MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024


class ArchiveVerificationError(RuntimeError):
    """Stable, payload-free archive rejection."""

    def __init__(self, code: str = "OFFLINE_ARCHIVE_INVALID") -> None:
        self.code = code
        super().__init__(code)


class OfflineAttestationError(RuntimeError):
    """Stable, payload-free import and resolution rejection."""

    def __init__(self, code: str = "OFFLINE_ATTESTATION_INVALID") -> None:
        self.code = code
        super().__init__(code)


@dataclasses.dataclass(frozen=True)
class VerifiedArchive:
    source_reference: str
    platform: str
    platform_manifest_digest: str
    runtime_image_id: str
    archive_sha256: str
    schema_min: int
    schema_max: int
    secret_bootstrap: str


@dataclasses.dataclass(frozen=True)
class AttestationRecord:
    version: int
    source_reference: str
    platform: str
    platform_manifest_digest: str
    runtime_image_id: str
    archive_sha256: str
    commit: str
    verification_run_id: str
    imported_at: str


@dataclasses.dataclass(frozen=True)
class _StoredBlob:
    size: int
    content: bytes | None


def _reject(code: str = "OFFLINE_ARCHIVE_INVALID") -> None:
    raise ArchiveVerificationError(code)


def _sha256_stream(source: BinaryIO) -> str:
    digest = hashlib.sha256()
    try:
        source.seek(0)
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
        source.seek(0)
    except OSError:
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    return digest.hexdigest()


def _unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            _reject()
        result[key] = value
    return result


def _reject_json_constant(_value: str) -> None:
    _reject("OFFLINE_ARCHIVE_JSON_INVALID")


def _parse_json(content: bytes | None) -> Any:
    if content is None or len(content) > MAX_JSON_BYTES:
        _reject()
    try:
        return json.loads(
            content.decode("utf-8"),
            object_pairs_hook=_unique_object,
            parse_constant=_reject_json_constant,
        )
    except ArchiveVerificationError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, ValueError, OverflowError):
        _reject("OFFLINE_ARCHIVE_JSON_INVALID")


def _safe_member_name(name: str) -> bool:
    if not name or "\\" in name or "\x00" in name:
        return False
    path = PurePosixPath(name)
    return not path.is_absolute() and all(part not in ("", ".", "..") for part in path.parts)


def _read_regular_member(
    archive: tarfile.TarFile,
    member: tarfile.TarInfo,
    capture_required: bool,
) -> tuple[str, bytes | None]:
    source = archive.extractfile(member)
    if source is None:
        _reject()
    digest = hashlib.sha256()
    captured = bytearray() if member.size <= MAX_JSON_BYTES else None
    remaining = member.size
    while remaining:
        chunk = source.read(min(1024 * 1024, remaining))
        if not chunk:
            _reject()
        remaining -= len(chunk)
        digest.update(chunk)
        if captured is not None:
            captured.extend(chunk)
    if source.read(1):
        _reject()
    content = bytes(captured) if captured is not None else None
    if content is not None and not capture_required:
        candidate = content.lstrip(b" \t\r\n")
        if not candidate.startswith((b"{", b"[")):
            content = None
    return digest.hexdigest(), content


def _read_archive(source: BinaryIO) -> tuple[dict[str, bytes], dict[str, _StoredBlob]]:
    roots: dict[str, bytes] = {}
    blobs: dict[str, _StoredBlob] = {}
    seen: set[str] = set()
    expanded_bytes = 0
    captured_bytes = 0
    try:
        with tarfile.open(fileobj=source, mode="r:*") as archive:
            for count, member in enumerate(archive, start=1):
                if count > MAX_MEMBERS or not _safe_member_name(member.name):
                    _reject()
                if member.name in seen:
                    _reject()
                seen.add(member.name)
                if getattr(member, "sparse", None):
                    _reject()
                if member.isdir():
                    if member.name not in ("blobs", "blobs/sha256") or member.size != 0:
                        _reject()
                    continue
                if not member.isreg() or member.size < 0:
                    _reject()
                if member.name not in ("oci-layout", "index.json", "manifest.json") and not BLOB_PATH.fullmatch(member.name):
                    _reject()
                expanded_bytes += member.size
                if expanded_bytes > MAX_ARCHIVE_BYTES:
                    _reject()
                blob_match = BLOB_PATH.fullmatch(member.name)
                actual_digest, content = _read_regular_member(
                    archive,
                    member,
                    capture_required=blob_match is None,
                )
                if content is not None:
                    captured_bytes += len(content)
                    if captured_bytes > MAX_CAPTURED_METADATA_BYTES:
                        _reject("OFFLINE_ARCHIVE_METADATA_LIMIT")
                if blob_match:
                    if actual_digest != blob_match.group(1):
                        _reject()
                    blobs[member.name] = _StoredBlob(member.size, content)
                else:
                    if member.size > MAX_JSON_BYTES or content is None:
                        _reject()
                    roots[member.name] = content
    except ArchiveVerificationError:
        raise
    except (OSError, tarfile.TarError, EOFError):
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    if set(roots) != {"oci-layout", "index.json", "manifest.json"}:
        _reject()
    return roots, blobs


def _descriptor_fields(value: Any) -> tuple[str, str, int]:
    if not isinstance(value, dict):
        _reject()
    media_type = value.get("mediaType")
    digest = value.get("digest")
    size = value.get("size")
    if (
        not isinstance(media_type, str)
        or not isinstance(digest, str)
        or not re.fullmatch(r"sha256:[0-9a-f]{64}", digest)
        or isinstance(size, bool)
        or not isinstance(size, int)
        or size < 0
    ):
        _reject()
    return media_type, digest, size


class _DescriptorGraph:
    def __init__(self, blobs: dict[str, _StoredBlob]) -> None:
        self.blobs = blobs
        self.reachable: set[str] = set()
        self.visited: set[str] = set()
        self.count = 0

    def blob_json(self, digest: str) -> Any:
        blob = self.blobs.get(f"blobs/sha256/{digest.removeprefix('sha256:')}")
        if blob is None:
            _reject()
        return _parse_json(blob.content)

    def visit(self, descriptor: Any, depth: int = 0) -> None:
        self.count += 1
        if self.count > MAX_MEMBERS or depth > MAX_DESCRIPTOR_DEPTH:
            _reject()
        media_type, digest, declared_size = _descriptor_fields(descriptor)
        path = f"blobs/sha256/{digest.removeprefix('sha256:')}"
        blob = self.blobs.get(path)
        if blob is None or blob.size != declared_size:
            _reject()
        self.reachable.add(path)
        if digest in self.visited:
            return
        self.visited.add(digest)
        if media_type == OCI_INDEX:
            document = self.blob_json(digest)
            if not isinstance(document, dict) or document.get("schemaVersion") != 2:
                _reject()
            manifests = document.get("manifests")
            if not isinstance(manifests, list):
                _reject()
            for child in manifests:
                self.visit(child, depth + 1)
            subject = document.get("subject")
            if subject is not None:
                self.visit(subject, depth + 1)
        elif media_type == OCI_MANIFEST:
            document = self.blob_json(digest)
            if not isinstance(document, dict) or document.get("schemaVersion") != 2:
                _reject()
            config = document.get("config")
            layers = document.get("layers")
            if not isinstance(config, dict) or not isinstance(layers, list):
                _reject()
            self.visit(config, depth + 1)
            for child in layers:
                self.visit(child, depth + 1)
            subject = document.get("subject")
            if subject is not None:
                self.visit(subject, depth + 1)


def _validate_root_index(index: Any, source_reference: str, blobs: dict[str, _StoredBlob]) -> dict[str, Any]:
    if (
        not isinstance(index, dict)
        or index.get("schemaVersion") != 2
        or index.get("mediaType") != OCI_INDEX
    ):
        _reject()
    manifests = index.get("manifests")
    if not isinstance(manifests, list) or len(manifests) != 1:
        _reject()
    source_descriptor = manifests[0]
    media_type, digest, size = _descriptor_fields(source_descriptor)
    if media_type != OCI_INDEX or digest != source_reference.rsplit("@", 1)[1]:
        _reject()
    annotations = source_descriptor.get("annotations")
    if not isinstance(annotations, dict) or annotations.get(SOURCE_ANNOTATION) != SOURCE_ANNOTATION_VALUE:
        _reject()
    blob = blobs.get(f"blobs/sha256/{digest.removeprefix('sha256:')}")
    if blob is None or blob.size != size:
        _reject()
    return source_descriptor


def _runtime_descriptor(source_index: Any) -> dict[str, Any]:
    if (
        not isinstance(source_index, dict)
        or source_index.get("schemaVersion") != 2
        or source_index.get("mediaType") != OCI_INDEX
        or not isinstance(source_index.get("manifests"), list)
    ):
        _reject()
    candidates = []
    for value in source_index["manifests"]:
        if not isinstance(value, dict) or value.get("mediaType") != OCI_MANIFEST:
            continue
        platform = value.get("platform")
        annotations = value.get("annotations")
        is_attestation = isinstance(annotations, dict) and annotations.get(
            "vnd.docker.reference.type"
        ) == "attestation-manifest"
        if (
            not is_attestation
            and "artifactType" not in value
            and "subject" not in value
            and isinstance(platform, dict)
            and platform.get("os") == "linux"
            and platform.get("architecture") == "amd64"
        ):
            candidates.append(value)
    if len(candidates) != 1:
        _reject()
    return candidates[0]


def _schema_labels(config: Any) -> tuple[int, int, str]:
    if not isinstance(config, dict) or config.get("os") != "linux" or config.get("architecture") != "amd64":
        _reject()
    runtime_config = config.get("config")
    labels = runtime_config.get("Labels") if isinstance(runtime_config, dict) else None
    if not isinstance(labels, dict):
        _reject()
    minimum = labels.get("io.kinvest.schema.min")
    maximum = labels.get("io.kinvest.schema.max")
    secret_bootstrap = labels.get("io.kinvest.secret-bootstrap")
    if (
        not isinstance(minimum, str)
        or not minimum.isascii()
        or not minimum.isdecimal()
        or not isinstance(maximum, str)
        or not maximum.isascii()
        or not maximum.isdecimal()
        or secret_bootstrap != "1"
    ):
        _reject()
    schema_min = int(minimum)
    schema_max = int(maximum)
    if schema_min > schema_max or schema_max > 2_147_483_647:
        _reject()
    return schema_min, schema_max, secret_bootstrap


def _validate_docker_manifest(value: Any, config_path: str, layer_paths: list[str]) -> None:
    if not isinstance(value, list) or len(value) != 1 or not isinstance(value[0], dict):
        _reject()
    entry = value[0]
    if "RepoTags" not in entry or entry["RepoTags"] not in (None, []):
        _reject()
    if entry.get("Config") != config_path or entry.get("Layers") != layer_paths:
        _reject()


def _verify_archive(
    archive: os.PathLike[str] | str,
    archive_sha256: str,
    source_reference: str,
) -> VerifiedArchive:
    if not isinstance(archive_sha256, str) or not SHA256.fullmatch(archive_sha256):
        _reject()
    if not isinstance(source_reference, str) or not ALLOWED_SOURCE.fullmatch(source_reference):
        _reject()
    try:
        path = Path(archive)
        path_metadata = path.lstat()
    except (OSError, TypeError, ValueError):
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    if not stat.S_ISREG(path_metadata.st_mode) or stat.S_ISLNK(path_metadata.st_mode):
        _reject()
    if path_metadata.st_size <= 0 or path_metadata.st_size > MAX_ARCHIVE_BYTES:
        _reject()
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    try:
        source = os.fdopen(descriptor, "rb")
    except OSError:
        try:
            os.close(descriptor)
        except OSError:
            pass
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    try:
        with source:
            opened_metadata = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(opened_metadata.st_mode)
                or (path_metadata.st_dev, path_metadata.st_ino)
                != (opened_metadata.st_dev, opened_metadata.st_ino)
                or opened_metadata.st_size <= 0
                or opened_metadata.st_size > MAX_ARCHIVE_BYTES
            ):
                _reject()
            if _sha256_stream(source) != archive_sha256:
                _reject("OFFLINE_ARCHIVE_CHECKSUM_MISMATCH")
            roots, blobs = _read_archive(source)
            final_checksum = _sha256_stream(source)
            final_metadata = os.fstat(source.fileno())
            stable_fields = ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns")
            if (
                final_checksum != archive_sha256
                or any(
                    getattr(opened_metadata, field) != getattr(final_metadata, field)
                    for field in stable_fields
                )
            ):
                _reject("OFFLINE_ARCHIVE_CHANGED")
    except ArchiveVerificationError:
        raise
    except OSError:
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    if _parse_json(roots["oci-layout"]) != {"imageLayoutVersion": "1.0.0"}:
        _reject()
    source_descriptor = _validate_root_index(
        _parse_json(roots["index.json"]), source_reference, blobs
    )
    graph = _DescriptorGraph(blobs)
    graph.visit(source_descriptor)
    if graph.reachable != set(blobs):
        _reject()

    source_index = graph.blob_json(source_descriptor["digest"])
    runtime_descriptor = _runtime_descriptor(source_index)
    runtime_manifest = graph.blob_json(runtime_descriptor["digest"])
    if (
        not isinstance(runtime_manifest, dict)
        or runtime_manifest.get("mediaType") != OCI_MANIFEST
        or "artifactType" in runtime_manifest
        or "subject" in runtime_manifest
    ):
        _reject()
    config_descriptor = runtime_manifest.get("config")
    layer_descriptors = runtime_manifest.get("layers")
    if not isinstance(config_descriptor, dict) or not isinstance(layer_descriptors, list):
        _reject()
    config_media_type, config_digest, _ = _descriptor_fields(config_descriptor)
    if config_media_type != OCI_CONFIG:
        _reject()
    config = graph.blob_json(config_digest)
    schema_min, schema_max, secret_bootstrap = _schema_labels(config)
    rootfs = config.get("rootfs")
    diff_ids = rootfs.get("diff_ids") if isinstance(rootfs, dict) and rootfs.get("type") == "layers" else None
    if (
        not isinstance(diff_ids, list)
        or len(diff_ids) != len(layer_descriptors)
        or any(not isinstance(value, str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", value) for value in diff_ids)
    ):
        _reject()

    layer_paths = []
    for layer in layer_descriptors:
        _, layer_digest, _ = _descriptor_fields(layer)
        layer_paths.append(f"blobs/sha256/{layer_digest.removeprefix('sha256:')}")
    config_path = f"blobs/sha256/{config_digest.removeprefix('sha256:')}"
    _validate_docker_manifest(
        _parse_json(roots["manifest.json"]), config_path, layer_paths
    )

    return VerifiedArchive(
        source_reference=source_reference,
        platform="linux/amd64",
        platform_manifest_digest=runtime_descriptor["digest"],
        runtime_image_id=config_digest,
        archive_sha256=archive_sha256,
        schema_min=schema_min,
        schema_max=schema_max,
        secret_bootstrap=secret_bootstrap,
    )


def verify_archive(
    archive: os.PathLike[str] | str,
    archive_sha256: str,
    source_reference: str,
) -> VerifiedArchive:
    try:
        return _verify_archive(archive, archive_sha256, source_reference)
    except ArchiveVerificationError:
        raise
    except (RecursionError, ValueError, OverflowError):
        _reject()


def _verified_archive_from_documents(
    roots: dict[str, bytes],
    blobs: dict[str, _StoredBlob],
    archive_sha256: str,
    source_reference: str,
) -> VerifiedArchive:
    if _parse_json(roots["oci-layout"]) != {"imageLayoutVersion": "1.0.0"}:
        _reject()
    source_descriptor = _validate_root_index(
        _parse_json(roots["index.json"]), source_reference, blobs
    )
    graph = _DescriptorGraph(blobs)
    graph.visit(source_descriptor)
    if graph.reachable != set(blobs):
        _reject()
    source_index = graph.blob_json(source_descriptor["digest"])
    runtime_descriptor = _runtime_descriptor(source_index)
    runtime_manifest = graph.blob_json(runtime_descriptor["digest"])
    if (
        not isinstance(runtime_manifest, dict)
        or runtime_manifest.get("mediaType") != OCI_MANIFEST
        or "artifactType" in runtime_manifest
        or "subject" in runtime_manifest
    ):
        _reject()
    config_descriptor = runtime_manifest.get("config")
    layer_descriptors = runtime_manifest.get("layers")
    if not isinstance(config_descriptor, dict) or not isinstance(layer_descriptors, list):
        _reject()
    config_media_type, config_digest, _ = _descriptor_fields(config_descriptor)
    if config_media_type != OCI_CONFIG:
        _reject()
    config = graph.blob_json(config_digest)
    schema_min, schema_max, secret_bootstrap = _schema_labels(config)
    rootfs = config.get("rootfs")
    diff_ids = (
        rootfs.get("diff_ids")
        if isinstance(rootfs, dict) and rootfs.get("type") == "layers"
        else None
    )
    if (
        not isinstance(diff_ids, list)
        or len(diff_ids) != len(layer_descriptors)
        or any(
            not isinstance(value, str)
            or not re.fullmatch(r"sha256:[0-9a-f]{64}", value)
            for value in diff_ids
        )
    ):
        _reject()
    layer_paths = []
    for layer in layer_descriptors:
        _, layer_digest, _ = _descriptor_fields(layer)
        layer_paths.append(f"blobs/sha256/{layer_digest.removeprefix('sha256:')}")
    config_path = f"blobs/sha256/{config_digest.removeprefix('sha256:')}"
    _validate_docker_manifest(
        _parse_json(roots["manifest.json"]), config_path, layer_paths
    )
    return VerifiedArchive(
        source_reference=source_reference,
        platform="linux/amd64",
        platform_manifest_digest=runtime_descriptor["digest"],
        runtime_image_id=config_digest,
        archive_sha256=archive_sha256,
        schema_min=schema_min,
        schema_max=schema_max,
        secret_bootstrap=secret_bootstrap,
    )


@contextlib.contextmanager
def _open_verified_archive_source(
    archive: os.PathLike[str] | str,
    archive_sha256: str,
    source_reference: str,
):
    if not isinstance(archive_sha256, str) or not SHA256.fullmatch(archive_sha256):
        _reject()
    if not isinstance(source_reference, str) or not ALLOWED_SOURCE.fullmatch(source_reference):
        _reject()
    try:
        path = Path(archive)
        path_metadata = path.lstat()
    except (OSError, TypeError, ValueError):
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    if not stat.S_ISREG(path_metadata.st_mode) or stat.S_ISLNK(path_metadata.st_mode):
        _reject()
    if path_metadata.st_size <= 0 or path_metadata.st_size > MAX_ARCHIVE_BYTES:
        _reject()
    flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError:
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    try:
        source = os.fdopen(descriptor, "rb")
    except OSError:
        try:
            os.close(descriptor)
        except OSError:
            pass
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    try:
        with source:
            opened_metadata = os.fstat(source.fileno())
            if (
                not stat.S_ISREG(opened_metadata.st_mode)
                or (path_metadata.st_dev, path_metadata.st_ino)
                != (opened_metadata.st_dev, opened_metadata.st_ino)
                or opened_metadata.st_size <= 0
                or opened_metadata.st_size > MAX_ARCHIVE_BYTES
            ):
                _reject()
            if _sha256_stream(source) != archive_sha256:
                _reject("OFFLINE_ARCHIVE_CHECKSUM_MISMATCH")
            roots, blobs = _read_archive(source)
            final_checksum = _sha256_stream(source)
            final_metadata = os.fstat(source.fileno())
            stable_fields = ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns")
            if (
                final_checksum != archive_sha256
                or any(
                    getattr(opened_metadata, field) != getattr(final_metadata, field)
                    for field in stable_fields
                )
            ):
                _reject("OFFLINE_ARCHIVE_CHANGED")
            verified = _verified_archive_from_documents(
                roots,
                blobs,
                archive_sha256,
                source_reference,
            )
            yield source, opened_metadata, verified
    except ArchiveVerificationError:
        raise
    except OSError:
        _reject("OFFLINE_ARCHIVE_UNREADABLE")


def _copy_verified_source_to_snapshot(source: BinaryIO, destination: BinaryIO) -> tuple[str, int]:
    digest = hashlib.sha256()
    total = 0
    try:
        source.seek(0)
        while True:
            chunk = source.read(1024 * 1024)
            if not chunk:
                break
            destination.write(chunk)
            digest.update(chunk)
            total += len(chunk)
        destination.flush()
        os.fsync(destination.fileno())
        source.seek(0)
    except OSError:
        _reject("OFFLINE_ARCHIVE_SNAPSHOT_FAILED")
    return digest.hexdigest(), total


@contextlib.contextmanager
def _verified_private_snapshot(
    archive_path: os.PathLike[str] | str,
    archive_sha256: str,
    source_reference: str,
    *,
    owner_uid: int,
    owner_gid: int,
):
    with _open_verified_archive_source(
        archive_path,
        archive_sha256,
        source_reference,
    ) as (source, opened_metadata, verified):
        with tempfile.TemporaryDirectory(prefix="kinvest-offline-import-") as directory_name:
            directory = Path(directory_name)
            try:
                directory.chmod(0o700)
                directory_metadata = directory.lstat()
            except OSError:
                _reject("OFFLINE_ARCHIVE_SNAPSHOT_FAILED")
            if (
                not stat.S_ISDIR(directory_metadata.st_mode)
                or stat.S_IMODE(directory_metadata.st_mode) != 0o700
                or directory_metadata.st_uid != owner_uid
                or directory_metadata.st_gid != owner_gid
            ):
                _reject("OFFLINE_ARCHIVE_SNAPSHOT_FAILED")
            snapshot_path = directory / "verified-image.tar"
            flags = (
                os.O_WRONLY
                | os.O_CREAT
                | os.O_EXCL
                | getattr(os, "O_CLOEXEC", 0)
                | getattr(os, "O_NOFOLLOW", 0)
            )
            try:
                descriptor = os.open(snapshot_path, flags, 0o600)
            except OSError:
                _reject("OFFLINE_ARCHIVE_SNAPSHOT_FAILED")
            try:
                destination = os.fdopen(descriptor, "wb")
            except OSError:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
                _reject("OFFLINE_ARCHIVE_SNAPSHOT_FAILED")
            with destination:
                try:
                    os.fchmod(destination.fileno(), 0o600)
                    metadata = os.fstat(destination.fileno())
                    if (metadata.st_uid, metadata.st_gid) != (owner_uid, owner_gid):
                        os.fchown(destination.fileno(), owner_uid, owner_gid)
                    copied_checksum, copied_size = _copy_verified_source_to_snapshot(
                        source,
                        destination,
                    )
                except ArchiveVerificationError:
                    raise
                except OSError:
                    _reject("OFFLINE_ARCHIVE_SNAPSHOT_FAILED")
            final_source_metadata = os.fstat(source.fileno())
            stable_fields = ("st_dev", "st_ino", "st_mode", "st_size", "st_mtime_ns")
            if (
                copied_checksum != archive_sha256
                or copied_size != opened_metadata.st_size
                or any(
                    getattr(opened_metadata, field)
                    != getattr(final_source_metadata, field)
                    for field in stable_fields
                )
            ):
                _reject("OFFLINE_ARCHIVE_CHANGED")
            try:
                snapshot_metadata = snapshot_path.lstat()
            except OSError:
                _reject("OFFLINE_ARCHIVE_SNAPSHOT_FAILED")
            if (
                not stat.S_ISREG(snapshot_metadata.st_mode)
                or stat.S_ISLNK(snapshot_metadata.st_mode)
                or stat.S_IMODE(snapshot_metadata.st_mode) != 0o600
                or snapshot_metadata.st_uid != owner_uid
                or snapshot_metadata.st_gid != owner_gid
                or snapshot_metadata.st_size != copied_size
            ):
                _reject("OFFLINE_ARCHIVE_SNAPSHOT_FAILED")
            yield verified, snapshot_path


def _attestation_reject(code: str = "OFFLINE_ATTESTATION_INVALID") -> None:
    raise OfflineAttestationError(code)


def _validate_timestamp(value: str) -> None:
    if not isinstance(value, str) or not RFC3339_UTC.fullmatch(value):
        _attestation_reject()
    try:
        datetime.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        _attestation_reject()


def _validate_record(record: AttestationRecord) -> None:
    if (
        record.version != 1
        or not ALLOWED_SOURCE.fullmatch(record.source_reference)
        or record.platform != "linux/amd64"
        or not IMAGE_ID.fullmatch(record.platform_manifest_digest)
        or not IMAGE_ID.fullmatch(record.runtime_image_id)
        or not SHA256.fullmatch(record.archive_sha256)
        or not COMMIT.fullmatch(record.commit)
        or not RUN_ID.fullmatch(record.verification_run_id)
    ):
        _attestation_reject()
    _validate_timestamp(record.imported_at)


def _record_text(record: AttestationRecord) -> str:
    _validate_record(record)
    values = (
        str(record.version),
        record.source_reference,
        record.platform,
        record.platform_manifest_digest,
        record.runtime_image_id,
        record.archive_sha256,
        record.commit,
        record.verification_run_id,
        record.imported_at,
    )
    return "".join(f"{key}={value}\n" for key, value in zip(RECORD_FIELDS, values))


def _parse_record(content: bytes) -> AttestationRecord:
    try:
        text = content.decode("utf-8")
    except UnicodeDecodeError:
        _attestation_reject()
    if not text.endswith("\n") or "\r" in text or "\x00" in text:
        _attestation_reject()
    lines = text[:-1].split("\n")
    if len(lines) != len(RECORD_FIELDS):
        _attestation_reject()
    values: list[str] = []
    for line, key in zip(lines, RECORD_FIELDS):
        prefix = f"{key}="
        if not line.startswith(prefix):
            _attestation_reject()
        values.append(line[len(prefix):])
    if values[0] != "1":
        _attestation_reject()
    record = AttestationRecord(
        version=1,
        source_reference=values[1],
        platform=values[2],
        platform_manifest_digest=values[3],
        runtime_image_id=values[4],
        archive_sha256=values[5],
        commit=values[6],
        verification_run_id=values[7],
        imported_at=values[8],
    )
    _validate_record(record)
    if _record_text(record) != text:
        _attestation_reject()
    return record


def _same_import(left: AttestationRecord, right: AttestationRecord) -> bool:
    return dataclasses.replace(left, imported_at=right.imported_at) == right


class AttestationStore:
    """Strict root-owned storage for immutable offline-image attestations."""

    def __init__(
        self,
        state_dir: os.PathLike[str] | str = DEFAULT_STATE_DIR,
        *,
        owner_uid: int = 0,
        owner_gid: int = 0,
    ) -> None:
        self.state_dir = Path(state_dir)
        self.owner_uid = owner_uid
        self.owner_gid = owner_gid
        self._prepare_directory()

    def _prepare_directory(self) -> None:
        try:
            self.state_dir.mkdir(mode=0o700)
        except FileExistsError:
            pass
        except OSError:
            _attestation_reject("OFFLINE_ATTESTATION_STATE_UNSAFE")
        self._check_directory()

    def _check_directory(self) -> None:
        try:
            metadata = self.state_dir.lstat()
        except OSError:
            _attestation_reject("OFFLINE_ATTESTATION_STATE_UNSAFE")
        if (
            not stat.S_ISDIR(metadata.st_mode)
            or stat.S_ISLNK(metadata.st_mode)
            or stat.S_IMODE(metadata.st_mode) != 0o700
            or metadata.st_uid != self.owner_uid
            or metadata.st_gid != self.owner_gid
        ):
            _attestation_reject("OFFLINE_ATTESTATION_STATE_UNSAFE")

    def _path(self, source_reference: str) -> Path:
        if not isinstance(source_reference, str) or not ALLOWED_SOURCE.fullmatch(source_reference):
            _attestation_reject()
        return self.state_dir / f"{source_reference.rsplit(':', 1)[1]}.state"

    def read(self, source_reference: str) -> AttestationRecord:
        self._check_directory()
        path = self._path(source_reference)
        try:
            path_metadata = path.lstat()
        except FileNotFoundError:
            _attestation_reject("OFFLINE_ATTESTATION_NOT_FOUND")
        except OSError:
            _attestation_reject("OFFLINE_ATTESTATION_RECORD_UNSAFE")
        if (
            not stat.S_ISREG(path_metadata.st_mode)
            or stat.S_ISLNK(path_metadata.st_mode)
            or stat.S_IMODE(path_metadata.st_mode) != 0o600
            or path_metadata.st_uid != self.owner_uid
            or path_metadata.st_gid != self.owner_gid
        ):
            _attestation_reject("OFFLINE_ATTESTATION_RECORD_UNSAFE")
        flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            descriptor = os.open(path, flags)
        except OSError:
            _attestation_reject("OFFLINE_ATTESTATION_RECORD_UNSAFE")
        try:
            source = os.fdopen(descriptor, "rb")
        except OSError:
            try:
                os.close(descriptor)
            except OSError:
                pass
            _attestation_reject("OFFLINE_ATTESTATION_RECORD_UNSAFE")
        try:
            with source:
                opened = os.fstat(source.fileno())
                if (
                    (opened.st_dev, opened.st_ino)
                    != (path_metadata.st_dev, path_metadata.st_ino)
                    or stat.S_IMODE(opened.st_mode) != 0o600
                    or opened.st_uid != self.owner_uid
                    or opened.st_gid != self.owner_gid
                    or opened.st_size <= 0
                    or opened.st_size > 4096
                ):
                    _attestation_reject("OFFLINE_ATTESTATION_RECORD_UNSAFE")
                content = source.read(4097)
        except OfflineAttestationError:
            raise
        except OSError:
            _attestation_reject("OFFLINE_ATTESTATION_RECORD_UNSAFE")
        record = _parse_record(content)
        if record.source_reference != source_reference:
            _attestation_reject()
        return record

    def write(self, record: AttestationRecord) -> AttestationRecord:
        self._check_directory()
        target = self._path(record.source_reference)
        content = _record_text(record).encode("utf-8")
        if target.exists() or target.is_symlink():
            existing = self.read(record.source_reference)
            if _same_import(existing, record):
                return existing
            _attestation_reject("OFFLINE_ATTESTATION_CONFLICT")
        descriptor = -1
        temporary_name: str | None = None
        published = False
        try:
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=".offline-attestation-",
                dir=self.state_dir,
            )
            os.fchmod(descriptor, 0o600)
            metadata = os.fstat(descriptor)
            if (metadata.st_uid, metadata.st_gid) != (self.owner_uid, self.owner_gid):
                os.fchown(descriptor, self.owner_uid, self.owner_gid)
            with os.fdopen(descriptor, "wb") as destination:
                descriptor = -1
                destination.write(content)
                destination.flush()
                os.fsync(destination.fileno())
            try:
                os.link(temporary_name, target, follow_symlinks=False)
                published = True
            except FileExistsError:
                existing = self.read(record.source_reference)
                if _same_import(existing, record):
                    return existing
                _attestation_reject("OFFLINE_ATTESTATION_CONFLICT")
            directory_descriptor = os.open(
                self.state_dir,
                os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_CLOEXEC", 0),
            )
            try:
                os.fsync(directory_descriptor)
            finally:
                os.close(directory_descriptor)
        except OfflineAttestationError:
            raise
        except OSError:
            if published:
                try:
                    target.unlink()
                except OSError:
                    pass
            _attestation_reject("OFFLINE_ATTESTATION_WRITE_FAILED")
        finally:
            if descriptor >= 0:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            if temporary_name is not None:
                try:
                    os.unlink(temporary_name)
                except FileNotFoundError:
                    pass
                except OSError:
                    pass
        return record


def _run_docker(arguments: list[str], timeout: int) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            arguments,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired):
        _attestation_reject("OFFLINE_ATTESTATION_DOCKER_FAILED")


def _docker_call(docker: Any, arguments: list[str], timeout: int, failure_code: str) -> str:
    try:
        result = docker(arguments, timeout)
    except OfflineAttestationError:
        raise
    except (OSError, subprocess.TimeoutExpired):
        _attestation_reject(failure_code)
    stdout = result.stdout if isinstance(result.stdout, str) else ""
    if result.returncode != 0 or len(stdout.encode("utf-8")) > MAX_DOCKER_OUTPUT_BYTES:
        _attestation_reject(failure_code)
    return stdout


def _inspect_image(runtime_image_id: str, docker: Any, unavailable_code: str) -> dict[str, Any]:
    output = _docker_call(
        docker,
        [
            "docker",
            "image",
            "inspect",
            runtime_image_id,
            "--format",
            "{{json .}}",
        ],
        DOCKER_INSPECT_TIMEOUT_SECONDS,
        unavailable_code,
    )
    try:
        inspection = json.loads(
            output,
            object_pairs_hook=_unique_object,
            parse_constant=lambda _value: _attestation_reject(),
        )
    except OfflineAttestationError:
        raise
    except (json.JSONDecodeError, RecursionError, ValueError, OverflowError):
        _attestation_reject("OFFLINE_ATTESTATION_IMAGE_MISMATCH")
    if not isinstance(inspection, dict):
        _attestation_reject("OFFLINE_ATTESTATION_IMAGE_MISMATCH")
    return inspection


def _inspection_labels(inspection: dict[str, Any]) -> tuple[int, int, str]:
    normalized = {
        "architecture": inspection.get("Architecture"),
        "config": inspection.get("Config"),
        "os": inspection.get("Os"),
    }
    try:
        return _schema_labels(normalized)
    except ArchiveVerificationError:
        _attestation_reject("OFFLINE_ATTESTATION_IMAGE_MISMATCH")


def _validate_inspection(
    inspection: dict[str, Any],
    runtime_image_id: str,
    expected_labels: tuple[int, int, str] | None = None,
) -> None:
    if (
        inspection.get("Id") != runtime_image_id
        or inspection.get("Os") != "linux"
        or inspection.get("Architecture") != "amd64"
    ):
        _attestation_reject("OFFLINE_ATTESTATION_IMAGE_MISMATCH")
    labels = _inspection_labels(inspection)
    if expected_labels is not None and labels != expected_labels:
        _attestation_reject("OFFLINE_ATTESTATION_IMAGE_MISMATCH")


def _validate_import_inputs(commit: str, verification_run_id: str) -> None:
    if (
        not isinstance(commit, str)
        or not COMMIT.fullmatch(commit)
        or not isinstance(verification_run_id, str)
        or not RUN_ID.fullmatch(verification_run_id)
    ):
        _attestation_reject()


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def import_archive(
    archive_path: os.PathLike[str] | str,
    *,
    archive_sha256: str,
    source_reference: str,
    commit: str,
    verification_run_id: str,
    state_dir: os.PathLike[str] | str = DEFAULT_STATE_DIR,
    docker: Any = _run_docker,
    now: Any = _utc_now,
    owner_uid: int = 0,
    owner_gid: int = 0,
) -> AttestationRecord:
    _validate_import_inputs(commit, verification_run_id)
    with _verified_private_snapshot(
        archive_path,
        archive_sha256,
        source_reference,
        owner_uid=owner_uid,
        owner_gid=owner_gid,
    ) as (verified, snapshot_path):
        _docker_call(
            docker,
            ["docker", "load", "--input", str(snapshot_path)],
            DOCKER_LOAD_TIMEOUT_SECONDS,
            "OFFLINE_ATTESTATION_LOAD_FAILED",
        )
        inspection = _inspect_image(
            verified.runtime_image_id,
            docker,
            "OFFLINE_ATTESTATION_IMAGE_UNAVAILABLE",
        )
        _validate_inspection(
            inspection,
            verified.runtime_image_id,
            (verified.schema_min, verified.schema_max, verified.secret_bootstrap),
        )
    record = AttestationRecord(
        version=1,
        source_reference=verified.source_reference,
        platform=verified.platform,
        platform_manifest_digest=verified.platform_manifest_digest,
        runtime_image_id=verified.runtime_image_id,
        archive_sha256=verified.archive_sha256,
        commit=commit,
        verification_run_id=verification_run_id,
        imported_at=now(),
    )
    return AttestationStore(
        state_dir,
        owner_uid=owner_uid,
        owner_gid=owner_gid,
    ).write(record)


def resolve_attestation(
    source_reference: str,
    commit: str,
    verification_run_id: str,
    *,
    state_dir: os.PathLike[str] | str = DEFAULT_STATE_DIR,
    docker: Any = _run_docker,
    owner_uid: int = 0,
    owner_gid: int = 0,
) -> str:
    _validate_import_inputs(commit, verification_run_id)
    record = AttestationStore(
        state_dir,
        owner_uid=owner_uid,
        owner_gid=owner_gid,
    ).read(source_reference)
    if record.commit != commit or record.verification_run_id != verification_run_id:
        _attestation_reject("OFFLINE_ATTESTATION_PROVENANCE_MISMATCH")
    inspection = _inspect_image(
        record.runtime_image_id,
        docker,
        "OFFLINE_ATTESTATION_IMAGE_UNAVAILABLE",
    )
    _validate_inspection(inspection, record.runtime_image_id)
    return record.runtime_image_id


def main(
    argv: list[str] | None = None,
    *,
    stdout: Any = sys.stdout,
    stderr: Any = sys.stderr,
    geteuid: Any = os.geteuid,
    state_dir: os.PathLike[str] | str = DEFAULT_STATE_DIR,
    docker: Any = _run_docker,
    now: Any = _utc_now,
    owner_uid: int = 0,
    owner_gid: int = 0,
) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        if arguments == ["self-check"]:
            stdout.write("KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK\n")
            return 0
        if len(arguments) == 4 and arguments[0] == "verify-archive":
            verified = verify_archive(arguments[1], arguments[2], arguments[3])
            stdout.write(
                f"KINVEST_OFFLINE_ARCHIVE_OK runtimeImageId={verified.runtime_image_id}\n"
            )
            return 0
        if len(arguments) == 6 and arguments[0] == "import":
            if geteuid() != 0:
                _attestation_reject("OFFLINE_ATTESTATION_ROOT_REQUIRED")
            record = import_archive(
                arguments[1],
                archive_sha256=arguments[2],
                source_reference=arguments[3],
                commit=arguments[4],
                verification_run_id=arguments[5],
                state_dir=state_dir,
                docker=docker,
                now=now,
                owner_uid=owner_uid,
                owner_gid=owner_gid,
            )
            stdout.write(
                f"KINVEST_OFFLINE_IMPORT_OK runtimeImageId={record.runtime_image_id}\n"
            )
            return 0
        if len(arguments) == 4 and arguments[0] == "resolve":
            if geteuid() != 0:
                _attestation_reject("OFFLINE_ATTESTATION_ROOT_REQUIRED")
            runtime_image_id = resolve_attestation(
                arguments[1],
                arguments[2],
                arguments[3],
                state_dir=state_dir,
                docker=docker,
                owner_uid=owner_uid,
                owner_gid=owner_gid,
            )
            stdout.write(runtime_image_id + "\n")
            return 0
        _attestation_reject("OFFLINE_ATTESTATION_USAGE")
    except (ArchiveVerificationError, OfflineAttestationError) as error:
        stderr.write(f"{error}\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
