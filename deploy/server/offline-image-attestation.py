#!/usr/bin/env python3
"""Bounded verification for Kinvest offline Docker/OCI archives."""

from __future__ import annotations

import dataclasses
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import tarfile
from typing import Any


ALLOWED_SOURCE = re.compile(
    r"^ghcr\.io/zwphhxx/kinvest@sha256:[0-9a-f]{64}$"
)
SHA256 = re.compile(r"^[0-9a-f]{64}$")
BLOB_PATH = re.compile(r"^blobs/sha256/([0-9a-f]{64})$")
MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024
MAX_MEMBERS = 4096
MAX_JSON_BYTES = 1024 * 1024
MAX_DESCRIPTOR_DEPTH = 8
SOURCE_ANNOTATION = "containerd.io/distribution.source.ghcr.io"
SOURCE_ANNOTATION_VALUE = "zwphhxx/kinvest"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"


class ArchiveVerificationError(RuntimeError):
    """Stable, payload-free archive rejection."""

    def __init__(self, code: str = "OFFLINE_ARCHIVE_INVALID") -> None:
        self.code = code
        super().__init__(code)


@dataclasses.dataclass(frozen=True)
class VerifiedArchive:
    source_digest: str
    platform: str
    platform_manifest_digest: str
    runtime_image_id: str
    archive_sha256: str
    schema_min: int
    schema_max: int
    secret_bootstrap: str


@dataclasses.dataclass(frozen=True)
class _StoredBlob:
    size: int
    content: bytes | None


def _reject(code: str = "OFFLINE_ARCHIVE_INVALID") -> None:
    raise ArchiveVerificationError(code)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    try:
        with path.open("rb") as source:
            while True:
                chunk = source.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
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


def _parse_json(content: bytes | None) -> Any:
    if content is None or len(content) > MAX_JSON_BYTES:
        _reject()
    try:
        return json.loads(content.decode("utf-8"), object_pairs_hook=_unique_object)
    except ArchiveVerificationError:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError):
        _reject()


def _safe_member_name(name: str) -> bool:
    if not name or "\\" in name or "\x00" in name:
        return False
    path = PurePosixPath(name)
    return not path.is_absolute() and all(part not in ("", ".", "..") for part in path.parts)


def _read_regular_member(archive: tarfile.TarFile, member: tarfile.TarInfo) -> tuple[str, bytes | None]:
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
    return digest.hexdigest(), bytes(captured) if captured is not None else None


def _read_archive(path: Path) -> tuple[dict[str, bytes], dict[str, _StoredBlob]]:
    roots: dict[str, bytes] = {}
    blobs: dict[str, _StoredBlob] = {}
    seen: set[str] = set()
    expanded_bytes = 0
    try:
        with tarfile.open(path, "r:*") as archive:
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
                actual_digest, content = _read_regular_member(archive, member)
                blob_match = BLOB_PATH.fullmatch(member.name)
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


def _validate_root_index(index: Any, source_ref: str, blobs: dict[str, _StoredBlob]) -> dict[str, Any]:
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
    if media_type != OCI_INDEX or digest != source_ref.rsplit("@", 1)[1]:
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
    if entry.get("RepoTags") not in (None, []):
        _reject()
    if entry.get("Config") != config_path or entry.get("Layers") != layer_paths:
        _reject()


def verify_archive(archive: os.PathLike[str] | str, archive_sha256: str, source_digest: str) -> VerifiedArchive:
    if not isinstance(archive_sha256, str) or not SHA256.fullmatch(archive_sha256):
        _reject()
    if not isinstance(source_digest, str) or not ALLOWED_SOURCE.fullmatch(source_digest):
        _reject()
    try:
        path = Path(archive)
        metadata = path.lstat()
    except (OSError, TypeError, ValueError):
        _reject("OFFLINE_ARCHIVE_UNREADABLE")
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        _reject()
    if metadata.st_size <= 0 or metadata.st_size > MAX_ARCHIVE_BYTES:
        _reject()
    if _sha256_file(path) != archive_sha256:
        _reject("OFFLINE_ARCHIVE_CHECKSUM_MISMATCH")

    roots, blobs = _read_archive(path)
    if _parse_json(roots["oci-layout"]) != {"imageLayoutVersion": "1.0.0"}:
        _reject()
    source_descriptor = _validate_root_index(
        _parse_json(roots["index.json"]), source_digest, blobs
    )
    graph = _DescriptorGraph(blobs)
    graph.visit(source_descriptor)
    if graph.reachable != set(blobs):
        _reject()

    source_index = graph.blob_json(source_descriptor["digest"])
    runtime_descriptor = _runtime_descriptor(source_index)
    runtime_manifest = graph.blob_json(runtime_descriptor["digest"])
    if not isinstance(runtime_manifest, dict):
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
        source_digest=source_digest,
        platform="linux/amd64",
        platform_manifest_digest=runtime_descriptor["digest"],
        runtime_image_id=config_digest,
        archive_sha256=archive_sha256,
        schema_min=schema_min,
        schema_max=schema_max,
        secret_bootstrap=secret_bootstrap,
    )
