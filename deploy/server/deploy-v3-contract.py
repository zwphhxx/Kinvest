#!/usr/bin/env python3
"""Secret-safe parser and state contract for the Kinvest deploy-v3 path."""

from __future__ import annotations

import base64
import binascii
import hashlib
import ipaddress
import json
import os
import re
import secrets
import stat
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


MAX_PAYLOAD_BYTES = 16 * 1024
MAX_LINE_BYTES = 6144
BUNDLE_ROOT = Path("/run/kinvest-secrets")
BUNDLE_UID = 0
BUNDLE_GID = 10001
BACKUP_ROOT = Path("/root/docker/kinvest/backups")
BACKUP_UID = 0
BACKUP_GID = 0
BUNDLE_MODE = 0o550
BUNDLE_FILE_MODE = 0o440
VERSION_PATTERN = re.compile(r"^v[0-9]{8}-[0-9]{3}$")
DIGEST_PATTERN = re.compile(
    r"^ghcr\.io/zwphhxx/kinvest@sha256:[0-9a-f]{64}$"
)
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
FINGERPRINT_PATTERN = re.compile(r"^[0-9a-f]{64}$")
BUNDLE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
TIMESTAMP_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
)
DEPLOY_PROTOCOL = os.environ.get("KINVEST_DEPLOY_PROTOCOL", "3")
IS_V4 = DEPLOY_PROTOCOL == "4"
STATE_FIELDS_V4 = (
    "protocolVersion",
    "imageDigest",
    "runtimeImageId",
    "commit",
    "schemaVersion",
    "imageSchemaMin",
    "imageSchemaMax",
    "secretProviderMode",
    "secretVersionIds",
    "secretBundleId",
    "secretMaterialFingerprints",
    "releaseRecordSchemaVersion",
    "verificationRunId",
    "artifactSource",
    "databaseBackupPath",
    "databaseBackupChecksum",
    "deployedAt",
)
STATE_FIELDS_V5 = (
    "protocolVersion",
    "imageDigest",
    "runtimeImageId",
    "commit",
    "schemaVersion",
    "imageSchemaMin",
    "imageSchemaMax",
    "secretProviderMode",
    "secretVersionIds",
    "secretBundleId",
    "secretMaterialFingerprints",
    "accessControlMode",
    "imageAccessControlContract",
    "trustedProxyAddresses",
    "trustedProxyConfigChecksum",
    "releaseRecordSchemaVersion",
    "verificationRunId",
    "artifactSource",
    "databaseBackupPath",
    "databaseBackupChecksum",
    "deployedAt",
)
LEDGER_FIELDS = ("adminPasswordVerifier", "deviceTokenHmac")
ATOMIC_RECOVERY_FORMAT = "kinvest-atomic-recovery-v1"


class ContractError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def fail(code: str) -> None:
    raise ContractError(code)


def canonical_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=True, separators=(",", ":"), sort_keys=True)


def require_exact_keys(value: Any, expected: set[str], code: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(code)
    return value


def parse_canonical_json(raw: str, expected: set[str], code: str) -> dict[str, Any]:
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        fail(code)
    value = require_exact_keys(value, expected, code)
    if canonical_json(value) != raw:
        fail(code)
    return value


def decode_base64url(raw: str, code: str, expected_size: int | None = None) -> bytearray:
    if not isinstance(raw, str) or not raw or re.fullmatch(r"[A-Za-z0-9_-]+", raw) is None:
        fail(code)
    try:
        decoded = bytearray(base64.urlsafe_b64decode(raw + "=" * ((4 - len(raw) % 4) % 4)))
    except (ValueError, TypeError):
        fail(code)
    if base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != raw or (
        expected_size is not None and len(decoded) != expected_size
    ):
        for index in range(len(decoded)):
            decoded[index] = 0
        fail(code)
    return decoded


def validate_admin_material(raw: str) -> bytearray:
    decoded = decode_base64url(raw, "DEPLOY_V3_ADMIN_MATERIAL_INVALID")
    try:
        if len(decoded) > 4096:
            fail("DEPLOY_V3_ADMIN_MATERIAL_INVALID")
        try:
            text = decoded.decode("utf-8")
        except UnicodeDecodeError:
            fail("DEPLOY_V3_ADMIN_MATERIAL_INVALID")
        value = parse_canonical_json(
            text,
            {"digest", "format", "n", "p", "r", "salt"},
            "DEPLOY_V3_ADMIN_MATERIAL_INVALID",
        )
        if (
            value["format"] != "kinvest-admin-scrypt-v1"
            or type(value["n"]) is not int
            or type(value["p"]) is not int
            or type(value["r"]) is not int
            or value["n"] != 65536
            or value["p"] != 1
            or value["r"] != 8
        ):
            fail("DEPLOY_V3_ADMIN_MATERIAL_INVALID")
        digest = decode_base64url(
            value["digest"], "DEPLOY_V3_ADMIN_MATERIAL_INVALID", 32
        )
        salt = decode_base64url(
            value["salt"], "DEPLOY_V3_ADMIN_MATERIAL_INVALID", 16
        )
        for value_buffer in (digest, salt):
            for index in range(len(value_buffer)):
                value_buffer[index] = 0
        return decoded
    except Exception:
        for index in range(len(decoded)):
            decoded[index] = 0
        raise


def validate_hmac_material(raw: str) -> bytearray:
    decoded = decode_base64url(raw, "DEPLOY_V3_HMAC_MATERIAL_INVALID", 32)
    for index in range(len(decoded)):
        decoded[index] = 0
    return bytearray(raw.encode("ascii"))


def canonical_secret_versions(admin_version: str, hmac_version: str) -> dict[str, Any]:
    if VERSION_PATTERN.fullmatch(admin_version) is None or VERSION_PATTERN.fullmatch(hmac_version) is None:
        fail("DEPLOY_V3_VERSION_ID_INVALID")
    return {
        "adminPasswordVerifier": admin_version,
        "deviceTokenHmac": {"accepted": [hmac_version], "active": hmac_version},
    }


def validate_secret_versions(value: Any, provider: str) -> dict[str, Any]:
    if provider == "disabled":
        if value != {}:
            fail("DEPLOY_V3_SECRET_CONFIG_INVALID")
        return {}
    value = require_exact_keys(
        value,
        {"adminPasswordVerifier", "deviceTokenHmac"},
        "DEPLOY_V3_SECRET_CONFIG_INVALID",
    )
    device = require_exact_keys(
        value["deviceTokenHmac"],
        {"accepted", "active"},
        "DEPLOY_V3_SECRET_CONFIG_INVALID",
    )
    admin_version = value["adminPasswordVerifier"]
    hmac_version = device["active"]
    expected = canonical_secret_versions(admin_version, hmac_version)
    if value != expected:
        fail("DEPLOY_V3_SECRET_CONFIG_INVALID")
    return expected


def validate_fingerprints(value: Any, provider: str) -> dict[str, str]:
    if provider == "disabled":
        if value != {}:
            fail("DEPLOY_V3_FINGERPRINT_INVALID")
        return {}
    value = require_exact_keys(
        value,
        {"adminPasswordVerifier", "deviceTokenHmac"},
        "DEPLOY_V3_FINGERPRINT_INVALID",
    )
    if any(
        not isinstance(item, str) or FINGERPRINT_PATTERN.fullmatch(item) is None
        for item in value.values()
    ):
        fail("DEPLOY_V3_FINGERPRINT_INVALID")
    return dict(value)


def read_payload(stream: Any = sys.stdin.buffer) -> tuple[dict[str, Any], bytearray | None, bytearray | None]:
    prefix = "DEPLOY_V4" if IS_V4 else "DEPLOY_V3"
    raw = stream.read(MAX_PAYLOAD_BYTES + 1)
    if len(raw) > MAX_PAYLOAD_BYTES:
        fail(f"{prefix}_PAYLOAD_TOO_LARGE")
    if b"\r" in raw or not raw.endswith(b"\n"):
        fail(f"{prefix}_PAYLOAD_INVALID")
    lines = raw[:-1].split(b"\n")
    expected_lines = 13 if IS_V4 else 12
    if len(lines) != expected_lines or any(len(line) > MAX_LINE_BYTES for line in lines):
        fail(f"{prefix}_PAYLOAD_INVALID")
    try:
        decoded = [line.decode("ascii") for line in lines]
        if IS_V4:
            (
                magic, intent, image_digest, commit, provenance_raw, registry_raw,
                provider, admin_version, hmac_version, admin_raw, hmac_raw,
                policy_raw, end,
            ) = decoded
        else:
            (
            magic,
            intent,
            image_digest,
            commit,
            provenance_raw,
            registry_raw,
            provider,
            admin_version,
            hmac_version,
            admin_raw,
            hmac_raw,
            end,
            ) = decoded
            policy_raw = '{"accessControlMode":"disabled","schemaVersion":1}'
    except UnicodeDecodeError:
        fail(f"{prefix}_PAYLOAD_INVALID")
    if magic != ("KINVEST_DEPLOY_V4" if IS_V4 else "KINVEST_DEPLOY_V3") or end != "EOF":
        fail(f"{prefix}_ENVELOPE_INVALID")
    if intent not in {"FORWARD", "ROLLBACK", "RESTORE"}:
        fail("DEPLOY_V3_INTENT_INVALID")
    if DIGEST_PATTERN.fullmatch(image_digest) is None:
        fail("DEPLOY_V3_DIGEST_INVALID")
    if COMMIT_PATTERN.fullmatch(commit) is None:
        fail("DEPLOY_V3_COMMIT_INVALID")
    provenance = parse_canonical_json(
        provenance_raw,
        {"artifactSource", "releaseRecordSchemaVersion", "verificationRunId"},
        "DEPLOY_V3_PROVENANCE_INVALID",
    )
    if (
        provenance["artifactSource"] != "ghcr-public"
        or type(provenance["releaseRecordSchemaVersion"]) is not int
        or provenance["releaseRecordSchemaVersion"] != 2
        or not isinstance(provenance["verificationRunId"], str)
        or re.fullmatch(r"[0-9]{1,20}", provenance["verificationRunId"]) is None
    ):
        fail("DEPLOY_V3_PROVENANCE_INVALID")
    registry = parse_canonical_json(
        registry_raw,
        {"host", "mode", "repository"},
        "DEPLOY_V3_REGISTRY_INVALID",
    )
    if registry != {
        "host": "ghcr.io",
        "mode": "ghcr-public",
        "repository": "ghcr.io/zwphhxx/kinvest",
    }:
        fail("DEPLOY_V3_REGISTRY_INVALID")
    if provider not in {"disabled", "github-tmpfs-v1"}:
        fail("DEPLOY_V3_PROVIDER_INVALID")
    policy = parse_canonical_json(
        policy_raw,
        {"accessControlMode", "schemaVersion"},
        "DEPLOY_V4_POLICY_INVALID" if IS_V4 else "DEPLOY_V3_POLICY_INVALID",
    )
    if type(policy["schemaVersion"]) is not int or policy["schemaVersion"] != 1 or policy["accessControlMode"] not in {"disabled", "device-approval"}:
        fail("DEPLOY_V4_POLICY_INVALID" if IS_V4 else "DEPLOY_V3_POLICY_INVALID")

    admin_material = None
    hmac_material = None
    if provider == "disabled":
        if any((admin_version, hmac_version, admin_raw, hmac_raw)):
            fail("DEPLOY_V3_DISABLED_FIELDS_INVALID")
        version_ids: dict[str, Any] = {}
        fingerprints: dict[str, str] = {}
    else:
        version_ids = canonical_secret_versions(admin_version, hmac_version)
        admin_material = validate_admin_material(admin_raw)
        try:
            hmac_material = validate_hmac_material(hmac_raw)
        except Exception:
            for index in range(len(admin_material)):
                admin_material[index] = 0
            raise
        fingerprints = {
            "adminPasswordVerifier": hashlib.sha256(admin_material).hexdigest(),
            "deviceTokenHmac": hashlib.sha256(hmac_material).hexdigest(),
        }

    metadata = {
        "artifactSource": provenance["artifactSource"],
        "commit": commit,
        "imageDigest": image_digest,
        "intent": intent,
        "registryHost": registry["host"],
        "registryMode": registry["mode"],
        "releaseRecordSchemaVersion": provenance["releaseRecordSchemaVersion"],
        "secretMaterialFingerprints": fingerprints,
        "secretProviderMode": provider,
        "secretVersionIds": version_ids,
        "verificationRunId": provenance["verificationRunId"],
    }
    if IS_V4:
        metadata["accessControlMode"] = policy["accessControlMode"]
        metadata["runtimePolicy"] = policy
    return metadata, admin_material, hmac_material


def ensure_safe_bundle_root(bundle_root: Path) -> None:
    if not bundle_root.is_absolute() or bundle_root.parent != Path("/run"):
        fail("DEPLOY_V3_BUNDLE_ROOT_UNSAFE")
    try:
        bundle_root.mkdir(mode=0o700, parents=False, exist_ok=True)
        info = bundle_root.lstat()
    except OSError:
        fail("DEPLOY_V3_BUNDLE_CREATE_FAILED")
    if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != 0:
        fail("DEPLOY_V3_BUNDLE_ROOT_UNSAFE")


def write_bundle_file(bundle_path: Path, name: str, value: bytearray) -> None:
    descriptor = None
    try:
        descriptor = os.open(
            bundle_path / name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o400,
        )
        os.fchown(descriptor, BUNDLE_UID, BUNDLE_GID)
        os.fchmod(descriptor, BUNDLE_FILE_MODE)
        view = memoryview(value)
        offset = 0
        while offset < len(view):
            offset += os.write(descriptor, view[offset:])
        os.fsync(descriptor)
    except OSError:
        fail("DEPLOY_V3_BUNDLE_CREATE_FAILED")
    finally:
        if descriptor is not None:
            os.close(descriptor)


def build_bundle(
    metadata: dict[str, Any],
    admin_material: bytearray | None,
    hmac_material: bytearray | None,
    bundle_root: Path = BUNDLE_ROOT,
) -> dict[str, Any]:
    if metadata["secretProviderMode"] == "disabled":
        return {**metadata, "secretBundleId": "none", "secretBundlePath": ""}
    if admin_material is None or hmac_material is None:
        fail("DEPLOY_V3_BUNDLE_CREATE_FAILED")
    ensure_safe_bundle_root(bundle_root)
    bundle_id = secrets.token_hex(16)
    bundle_path = bundle_root / bundle_id
    try:
        bundle_path.mkdir(mode=0o700)
        os.chown(bundle_path, BUNDLE_UID, BUNDLE_GID)
        write_bundle_file(bundle_path, "admin-password-verifier", admin_material)
        write_bundle_file(bundle_path, "device-token-hmac-key", hmac_material)
        versions = metadata["secretVersionIds"]
        fingerprints = metadata["secretMaterialFingerprints"]
        manifest = {
            "format": "kinvest-github-tmpfs-v1",
            "adminPasswordVerifier": {
                "file": "admin-password-verifier",
                "versionId": versions["adminPasswordVerifier"],
                "sha256": fingerprints["adminPasswordVerifier"],
            },
            "deviceTokenHmac": {
                "file": "device-token-hmac-key",
                "versionId": versions["deviceTokenHmac"]["active"],
                "sha256": fingerprints["deviceTokenHmac"],
            },
        }
        manifest_buffer = bytearray(
            json.dumps(manifest, ensure_ascii=True, separators=(",", ":")).encode("ascii")
        )
        try:
            write_bundle_file(bundle_path, "manifest.json", manifest_buffer)
        finally:
            for index in range(len(manifest_buffer)):
                manifest_buffer[index] = 0
        os.chmod(bundle_path, BUNDLE_MODE)
        return {
            **metadata,
            "secretBundleId": bundle_id,
            "secretBundlePath": str(bundle_path),
        }
    except Exception:
        try:
            os.chmod(bundle_path, 0o700)
            for child in bundle_path.iterdir():
                child.unlink(missing_ok=True)
            bundle_path.rmdir()
        except OSError:
            pass
        raise


def validate_state(value: Any) -> dict[str, Any]:
    code = "DEPLOY_V4_STATE_INVALID" if IS_V4 else "DEPLOY_V3_STATE_INVALID"
    if not isinstance(value, dict):
        fail(code)
    protocol_version = value.get("protocolVersion")
    if protocol_version == 4:
        value = require_exact_keys(value, set(STATE_FIELDS_V4), code)
        if IS_V4:
            value = {
                **value,
                "protocolVersion": 5,
                "accessControlMode": "disabled",
                "imageAccessControlContract": 0,
                "trustedProxyAddresses": [],
                "trustedProxyConfigChecksum": "",
            }
    elif protocol_version == 5 and IS_V4:
        value = require_exact_keys(value, set(STATE_FIELDS_V5), code)
    else:
        fail(code)
    if DIGEST_PATTERN.fullmatch(value["imageDigest"]) is None:
        fail("DEPLOY_V3_STATE_INVALID")
    if IMAGE_ID_PATTERN.fullmatch(value["runtimeImageId"]) is None:
        fail("DEPLOY_V3_STATE_INVALID")
    if COMMIT_PATTERN.fullmatch(value["commit"]) is None:
        fail("DEPLOY_V3_STATE_INVALID")
    for field in ("schemaVersion", "imageSchemaMin", "imageSchemaMax"):
        if type(value[field]) is not int or value[field] < 0:
            fail(code)
    if not value["imageSchemaMin"] <= value["schemaVersion"] <= value["imageSchemaMax"]:
        fail("DEPLOY_V3_STATE_INVALID")
    provider = value["secretProviderMode"]
    if provider not in {"disabled", "github-tmpfs-v1"}:
        fail("DEPLOY_V3_STATE_INVALID")
    versions = validate_secret_versions(value["secretVersionIds"], provider)
    fingerprints = validate_fingerprints(value["secretMaterialFingerprints"], provider)
    if provider == "disabled":
        if value["secretBundleId"] != "none":
            fail("DEPLOY_V3_STATE_INVALID")
    elif BUNDLE_ID_PATTERN.fullmatch(value["secretBundleId"]) is None:
        fail("DEPLOY_V3_STATE_INVALID")
    if type(value["releaseRecordSchemaVersion"]) is not int or value["releaseRecordSchemaVersion"] != 2:
        fail(code)
    if not isinstance(value["verificationRunId"], str) or re.fullmatch(
        r"[0-9]{1,20}", value["verificationRunId"]
    ) is None:
        fail("DEPLOY_V3_STATE_INVALID")
    if value["artifactSource"] != "ghcr-public":
        fail("DEPLOY_V3_STATE_INVALID")
    backup_path = value["databaseBackupPath"]
    backup_checksum = value["databaseBackupChecksum"]
    if (backup_path, backup_checksum) != ("none", "none"):
        if (
            not isinstance(backup_path, str)
            or not backup_path.startswith("/root/docker/kinvest/backups/")
            or not isinstance(backup_checksum, str)
            or FINGERPRINT_PATTERN.fullmatch(backup_checksum) is None
        ):
            fail("DEPLOY_V3_STATE_INVALID")
    if not isinstance(value["deployedAt"], str) or TIMESTAMP_PATTERN.fullmatch(value["deployedAt"]) is None:
        fail(code)
    try:
        datetime.strptime(value["deployedAt"], "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        fail(code)
    if value["protocolVersion"] == 5:
        mode = value["accessControlMode"]
        contract = value["imageAccessControlContract"]
        proxies = value["trustedProxyAddresses"]
        checksum = value["trustedProxyConfigChecksum"]
        if mode not in {"disabled", "device-approval"} or type(contract) is not int or contract not in {0, 1}:
            fail(code)
        if not isinstance(proxies, list) or len(set(proxies)) != len(proxies):
            fail(code)
        try:
            if any(str(ipaddress.IPv4Address(item)) != item for item in proxies):
                fail(code)
        except (ipaddress.AddressValueError, TypeError):
            fail(code)
        if mode == "disabled":
            if proxies != [] or checksum != "":
                fail(code)
        elif contract != 1 or len(proxies) != 1 or not isinstance(checksum, str) or FINGERPRINT_PATTERN.fullmatch(checksum) is None:
            fail(code)
    normalized = dict(value)
    normalized["secretVersionIds"] = versions
    normalized["secretMaterialFingerprints"] = fingerprints
    return normalized


def state_text(value: Any) -> str:
    normalized = validate_state(value)
    lines = []
    fields = STATE_FIELDS_V5 if normalized["protocolVersion"] == 5 else STATE_FIELDS_V4
    for field in fields:
        field_value = normalized[field]
        if isinstance(field_value, (dict, list)):
            rendered = canonical_json(field_value)
        else:
            rendered = str(field_value)
        if "\n" in rendered or "\r" in rendered:
            fail("DEPLOY_V3_STATE_INVALID")
        lines.append(f"{field}={rendered}")
    return "\n".join(lines) + "\n"


def state_from_text(raw: str) -> dict[str, Any]:
    lines = raw.splitlines()
    if lines and lines[0] == "protocolVersion=3":
        legacy_fields = (
            "protocolVersion", "imageDigest", "runtimeImageId", "commit",
            "schemaVersion", "imageSchemaMin", "imageSchemaMax",
            "secretVersionIds", "releaseRecordSchemaVersion",
            "verificationRunId", "artifactSource", "databaseBackupPath",
            "databaseBackupChecksum", "deployedAt",
        )
        if len(lines) != len(legacy_fields) or not raw.endswith("\n"):
            fail("DEPLOY_V3_STATE_INVALID")
        legacy: dict[str, str] = {}
        for field, line in zip(legacy_fields, lines):
            prefix = field + "="
            if not line.startswith(prefix):
                fail("DEPLOY_V3_STATE_INVALID")
            legacy[field] = line[len(prefix):]
        if legacy["secretVersionIds"] != "{}":
            fail("DEPLOY_V3_STATE_PROVIDER_MIGRATION_REQUIRED")
        try:
            migrated = {
                "protocolVersion": 4,
                "imageDigest": legacy["imageDigest"],
                "runtimeImageId": legacy["runtimeImageId"],
                "commit": legacy["commit"],
                "schemaVersion": int(legacy["schemaVersion"]),
                "imageSchemaMin": int(legacy["imageSchemaMin"]),
                "imageSchemaMax": int(legacy["imageSchemaMax"]),
                "secretProviderMode": "disabled",
                "secretVersionIds": {},
                "secretBundleId": "none",
                "secretMaterialFingerprints": {},
                "releaseRecordSchemaVersion": int(legacy["releaseRecordSchemaVersion"]),
                "verificationRunId": legacy["verificationRunId"],
                "artifactSource": legacy["artifactSource"],
                "databaseBackupPath": legacy["databaseBackupPath"],
                "databaseBackupChecksum": legacy["databaseBackupChecksum"],
                "deployedAt": legacy["deployedAt"],
            }
        except ValueError:
            fail("DEPLOY_V3_STATE_INVALID")
        return validate_state(migrated)
    if lines and lines[0] == "protocolVersion=5":
        fields = STATE_FIELDS_V5
    elif lines and lines[0] == "protocolVersion=4":
        fields = STATE_FIELDS_V4
    else:
        fail("DEPLOY_V4_STATE_INVALID" if IS_V4 else "DEPLOY_V3_STATE_INVALID")
    if len(lines) != len(fields) or not raw.endswith("\n"):
        fail("DEPLOY_V4_STATE_INVALID" if IS_V4 else "DEPLOY_V3_STATE_INVALID")
    value: dict[str, Any] = {}
    for field, line in zip(fields, lines):
        prefix = field + "="
        if not line.startswith(prefix):
            fail("DEPLOY_V3_STATE_INVALID")
        item = line[len(prefix):]
        if field in {"protocolVersion", "schemaVersion", "imageSchemaMin", "imageSchemaMax", "imageAccessControlContract", "releaseRecordSchemaVersion"}:
            if re.fullmatch(r"0|[1-9][0-9]*", item) is None:
                fail("DEPLOY_V3_STATE_INVALID")
            value[field] = int(item)
        elif field in {"secretVersionIds", "secretMaterialFingerprints", "trustedProxyAddresses"}:
            try:
                value[field] = json.loads(item)
            except ValueError:
                fail("DEPLOY_V3_STATE_INVALID")
            if canonical_json(value[field]) != item:
                fail("DEPLOY_V3_STATE_INVALID")
        else:
            value[field] = item
    return validate_state(value)


def check_version_reuse(current: dict[str, Any], candidate: dict[str, Any]) -> None:
    current = validate_state(current)
    provider = candidate.get("secretProviderMode")
    versions = validate_secret_versions(candidate.get("secretVersionIds"), provider)
    fingerprints = validate_fingerprints(candidate.get("secretMaterialFingerprints"), provider)
    if current["secretProviderMode"] != "github-tmpfs-v1" or provider != "github-tmpfs-v1":
        return
    pairs = (
        ("adminPasswordVerifier", current["secretVersionIds"]["adminPasswordVerifier"], versions["adminPasswordVerifier"]),
        ("deviceTokenHmac", current["secretVersionIds"]["deviceTokenHmac"]["active"], versions["deviceTokenHmac"]["active"]),
    )
    for key, current_version, candidate_version in pairs:
        if current_version == candidate_version and current["secretMaterialFingerprints"][key] != fingerprints[key]:
            fail("SECRET_VERSION_REUSE_CONFLICT")


def candidate_version_fingerprints(candidate: Any) -> dict[str, tuple[str, str]]:
    if not isinstance(candidate, dict):
        fail("DEPLOY_V3_LEDGER_INVALID")
    provider = candidate.get("secretProviderMode")
    versions = validate_secret_versions(candidate.get("secretVersionIds"), provider)
    fingerprints = validate_fingerprints(candidate.get("secretMaterialFingerprints"), provider)
    if provider == "disabled":
        return {}
    return {
        "adminPasswordVerifier": (
            versions["adminPasswordVerifier"],
            fingerprints["adminPasswordVerifier"],
        ),
        "deviceTokenHmac": (
            versions["deviceTokenHmac"]["active"],
            fingerprints["deviceTokenHmac"],
        ),
    }


def empty_version_ledger() -> dict[str, dict[str, str]]:
    return {field: {} for field in LEDGER_FIELDS}


def validate_version_ledger(value: Any) -> dict[str, dict[str, str]]:
    value = require_exact_keys(value, set(LEDGER_FIELDS), "DEPLOY_V3_LEDGER_INVALID")
    normalized: dict[str, dict[str, str]] = {}
    for field in LEDGER_FIELDS:
        entries = value[field]
        if not isinstance(entries, dict):
            fail("DEPLOY_V3_LEDGER_INVALID")
        if any(
            not isinstance(version, str)
            or VERSION_PATTERN.fullmatch(version) is None
            or not isinstance(fingerprint, str)
            or FINGERPRINT_PATTERN.fullmatch(fingerprint) is None
            for version, fingerprint in entries.items()
        ):
            fail("DEPLOY_V3_LEDGER_INVALID")
        normalized[field] = dict(sorted(entries.items()))
    return normalized


def validate_atomic_destination(destination: Path, code: str) -> None:
    if not destination.is_absolute() or not destination.parent.is_dir():
        fail(code)
    try:
        if destination.is_symlink():
            fail(code)
    except OSError:
        fail(code)


def write_temporary(
    parent: Path,
    prefix: str,
    encoded: bytes,
    mode: int = 0o600,
    uid: int | None = None,
    gid: int | None = None,
) -> str:
    descriptor = None
    temporary = None
    try:
        descriptor, temporary = tempfile.mkstemp(prefix=prefix, dir=parent)
        os.fchmod(descriptor, mode)
        os.fchown(
            descriptor,
            os.geteuid() if uid is None else uid,
            os.getegid() if gid is None else gid,
        )
        offset = 0
        while offset < len(encoded):
            offset += os.write(descriptor, encoded[offset:])
        os.fsync(descriptor)
        os.close(descriptor)
        descriptor = None
        return temporary
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if descriptor is not None and temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def fsync_directory(directory: Path) -> None:
    descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def read_existing_atomic_target(destination: Path, code: str) -> dict[str, Any]:
    try:
        info = destination.lstat()
    except FileNotFoundError:
        return {"exists": False, "bytes": b"", "mode": 0o600, "uid": os.geteuid(), "gid": os.getegid()}
    except OSError:
        fail(code)
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid():
        fail(code)
    descriptor = None
    try:
        descriptor = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino) or opened.st_size > 64 * 1024:
            fail(code)
        data = bytearray()
        while len(data) <= 64 * 1024:
            chunk = os.read(descriptor, min(8192, 64 * 1024 + 1 - len(data)))
            if not chunk:
                break
            data.extend(chunk)
        if len(data) > 64 * 1024:
            fail(code)
        return {
            "exists": True,
            "bytes": bytes(data),
            "mode": stat.S_IMODE(info.st_mode),
            "uid": info.st_uid,
            "gid": info.st_gid,
        }
    except OSError:
        fail(code)
    finally:
        if descriptor is not None:
            os.close(descriptor)


def atomic_replace_bytes(destination: Path, encoded: bytes, code: str) -> None:
    validate_atomic_destination(destination, code)
    original = read_existing_atomic_target(destination, code)
    recovery = destination.with_name(f".{destination.name}.recovery-required")
    if recovery.exists() or recovery.is_symlink():
        fail("DEPLOY_V3_ATOMIC_RECOVERY_REQUIRED")
    recovery_value = {
        "destinationExisted": original["exists"],
        "format": ATOMIC_RECOVERY_FORMAT,
        "gid": original["gid"],
        "mode": original["mode"],
        "newSha256": hashlib.sha256(encoded).hexdigest(),
        "sha256": hashlib.sha256(original["bytes"]).hexdigest(),
        "uid": original["uid"],
        "valueBase64": base64.b64encode(original["bytes"]).decode("ascii"),
    }
    recovery_temporary = None
    candidate_temporary = None
    replaced = False
    restored = False
    try:
        recovery_temporary = write_temporary(
            destination.parent,
            f".{destination.name}.recovery.",
            (canonical_json(recovery_value) + "\n").encode("ascii"),
        )
        os.replace(recovery_temporary, recovery)
        recovery_temporary = None
        fsync_directory(destination.parent)

        candidate_temporary = write_temporary(
            destination.parent,
            f".{destination.name}.candidate.",
            encoded,
        )
        os.replace(candidate_temporary, destination)
        candidate_temporary = None
        replaced = True
        fsync_directory(destination.parent)

        injection_target = os.environ.get("KINVEST_V3_TEST_FAIL_AFTER_REPLACE")
        marker = os.environ.get("KINVEST_V3_TEST_FAIL_MARKER")
        if injection_target == str(destination) and marker:
            try:
                marker_descriptor = os.open(marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            except FileExistsError:
                marker_descriptor = None
            if marker_descriptor is not None:
                os.close(marker_descriptor)
                raise OSError("injected post-replace failure")

        recovery.unlink()
        fsync_directory(destination.parent)
        return
    except OSError:
        if replaced:
            try:
                if original["exists"]:
                    restore_temporary = write_temporary(
                        destination.parent,
                        f".{destination.name}.restore.",
                        original["bytes"],
                        original["mode"],
                        original["uid"],
                        original["gid"],
                    )
                    try:
                        os.replace(restore_temporary, destination)
                    except Exception:
                        try:
                            os.unlink(restore_temporary)
                        except OSError:
                            pass
                        raise
                else:
                    destination.unlink(missing_ok=True)
                fsync_directory(destination.parent)
                restored = True
            except OSError:
                restored = False
        else:
            restored = True
        if restored:
            try:
                recovery.unlink(missing_ok=True)
                fsync_directory(destination.parent)
            except OSError:
                pass
        fail(code)
    finally:
        for temporary in (recovery_temporary, candidate_temporary):
            if temporary is not None:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass


def atomic_write_state(destination: Path, value: Any) -> None:
    atomic_replace_bytes(
        destination,
        state_text(value).encode("ascii"),
        "DEPLOY_V3_STATE_WRITE_FAILED",
    )


def reconcile_atomic_state(destination: Path) -> None:
    validate_atomic_destination(destination, "DEPLOY_V3_ATOMIC_RECOVERY_INVALID")
    recovery = destination.with_name(f".{destination.name}.recovery-required")
    try:
        info = recovery.lstat()
    except FileNotFoundError:
        return
    except OSError:
        fail("DEPLOY_V3_ATOMIC_RECOVERY_INVALID")
    if (
        not stat.S_ISREG(info.st_mode)
        or stat.S_IMODE(info.st_mode) != 0o600
        or info.st_uid != os.geteuid()
        or info.st_size > 128 * 1024
    ):
        fail("DEPLOY_V3_ATOMIC_RECOVERY_INVALID")
    descriptor = None
    try:
        descriptor = os.open(recovery, os.O_RDONLY | os.O_NOFOLLOW)
        raw = os.read(descriptor, 128 * 1024 + 1)
        if len(raw) > 128 * 1024:
            fail("DEPLOY_V3_ATOMIC_RECOVERY_INVALID")
        value = json.loads(raw.decode("ascii"))
    except (OSError, UnicodeError, ValueError):
        fail("DEPLOY_V3_ATOMIC_RECOVERY_INVALID")
    finally:
        if descriptor is not None:
            os.close(descriptor)
    value = require_exact_keys(
        value,
        {
            "destinationExisted", "format", "gid", "mode",
            "newSha256", "sha256", "uid", "valueBase64",
        },
        "DEPLOY_V3_ATOMIC_RECOVERY_INVALID",
    )
    if (
        value["format"] != ATOMIC_RECOVERY_FORMAT
        or not isinstance(value["destinationExisted"], bool)
        or type(value["uid"]) is not int
        or type(value["gid"]) is not int
        or type(value["mode"]) is not int
        or value["mode"] != 0o600
        or FINGERPRINT_PATTERN.fullmatch(value["sha256"]) is None
        or FINGERPRINT_PATTERN.fullmatch(value["newSha256"]) is None
        or not isinstance(value["valueBase64"], str)
    ):
        fail("DEPLOY_V3_ATOMIC_RECOVERY_INVALID")
    try:
        original = base64.b64decode(value["valueBase64"], validate=True)
    except (ValueError, binascii.Error):
        fail("DEPLOY_V3_ATOMIC_RECOVERY_INVALID")
    if hashlib.sha256(original).hexdigest() != value["sha256"]:
        fail("DEPLOY_V3_ATOMIC_RECOVERY_INVALID")
    current = read_existing_atomic_target(destination, "DEPLOY_V3_ATOMIC_RECOVERY_INVALID")
    current_hash = hashlib.sha256(current["bytes"]).hexdigest()
    matches_new = current["exists"] and current_hash == value["newSha256"]
    matches_original = (
        current["exists"] == value["destinationExisted"]
        and (
            not current["exists"]
            or (
                current["bytes"] == original
                and current["mode"] == value["mode"]
                and current["uid"] == value["uid"]
                and current["gid"] == value["gid"]
            )
        )
    )
    if not matches_new and not matches_original:
        fail("DEPLOY_V3_ATOMIC_RECOVERY_REQUIRED")
    try:
        recovery.unlink()
        fsync_directory(destination.parent)
    except OSError:
        fail("DEPLOY_V3_ATOMIC_RECOVERY_INVALID")


DEPLOY_JOURNAL_FORMAT = "kinvest-deploy-transaction-v1"
DEPLOY_JOURNAL_STAGES = {
    "before-attempt", "attempt-written", "before-previous", "previous-written",
    "before-compose", "compose-finished", "before-current", "current-written",
}


def deploy_journal_slot(destination: Path) -> dict[str, Any]:
    original = read_existing_atomic_target(destination, "DEPLOY_JOURNAL_INVALID")
    raw = original["bytes"]
    if original["exists"]:
        try:
            text = raw.decode("ascii")
        except UnicodeError:
            fail("DEPLOY_JOURNAL_INVALID")
        if not text.startswith(("protocolVersion=3\n", "protocolVersion=4\n", "protocolVersion=5\n")):
            fail("DEPLOY_JOURNAL_INVALID")
    return {
        "existed": original["exists"],
        "gid": original["gid"],
        "mode": original["mode"],
        "name": destination.name,
        "sha256": hashlib.sha256(raw).hexdigest(),
        "uid": original["uid"],
        "valueBase64": base64.b64encode(raw).decode("ascii"),
    }


def write_deploy_journal(destination: Path, value: dict[str, Any]) -> None:
    validate_atomic_destination(destination, "DEPLOY_JOURNAL_INVALID")
    encoded = (canonical_json(value) + "\n").encode("ascii")
    temporary = None
    try:
        temporary = write_temporary(destination.parent, ".deploy-journal.", encoded)
        os.replace(temporary, destination)
        temporary = None
        fsync_directory(destination.parent)
    except OSError:
        fail("DEPLOY_JOURNAL_WRITE_FAILED")
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def load_deploy_journal(destination: Path) -> dict[str, Any] | None:
    validate_atomic_destination(destination, "DEPLOY_JOURNAL_INVALID")
    try:
        info = destination.lstat()
    except FileNotFoundError:
        return None
    except OSError:
        fail("DEPLOY_JOURNAL_INVALID")
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid() or info.st_size > 512 * 1024:
        fail("DEPLOY_JOURNAL_INVALID")
    descriptor = None
    try:
        descriptor = os.open(destination, os.O_RDONLY | os.O_NOFOLLOW)
        raw = os.read(descriptor, 512 * 1024 + 1)
        value = json.loads(raw.decode("ascii"))
    except (OSError, UnicodeError, ValueError):
        fail("DEPLOY_JOURNAL_INVALID")
    finally:
        if descriptor is not None:
            os.close(descriptor)
    value = require_exact_keys(value, {
        "beforeImageSummary", "databaseBackupChecksum", "databaseBackupPath", "format",
        "originalProtocolVersion", "slots", "stage", "targetSchemaMax",
        "targetSchemaMin", "targetSchemaVersion", "targetSummary",
    }, "DEPLOY_JOURNAL_INVALID")
    if (
        raw != (canonical_json(value) + "\n").encode("ascii")
        or value["format"] != DEPLOY_JOURNAL_FORMAT
        or type(value["originalProtocolVersion"]) is not int
        or value["originalProtocolVersion"] not in {3, 4, 5}
        or value["stage"] not in DEPLOY_JOURNAL_STAGES
        or not isinstance(value["beforeImageSummary"], str)
        or FINGERPRINT_PATTERN.fullmatch(value["beforeImageSummary"]) is None
        or type(value["targetSchemaVersion"]) is not int
        or type(value["targetSchemaMin"]) is not int
        or type(value["targetSchemaMax"]) is not int
        or not value["targetSchemaMin"] <= value["targetSchemaVersion"] <= value["targetSchemaMax"]
        or not isinstance(value["targetSummary"], str)
        or FINGERPRINT_PATTERN.fullmatch(value["targetSummary"]) is None
        or not isinstance(value["slots"], list)
        or len(value["slots"]) != 3
    ):
        fail("DEPLOY_JOURNAL_INVALID")
    for slot in value["slots"]:
        slot = require_exact_keys(slot, {"existed", "gid", "mode", "name", "sha256", "uid", "valueBase64"}, "DEPLOY_JOURNAL_INVALID")
        if (
            slot["name"] not in {"current.state", "previous.state", "attempt.state"}
            or not isinstance(slot["existed"], bool)
            or type(slot["gid"]) is not int
            or type(slot["mode"]) is not int
            or type(slot["uid"]) is not int
            or slot["mode"] != 0o600
            or FINGERPRINT_PATTERN.fullmatch(slot["sha256"]) is None
            or not isinstance(slot["valueBase64"], str)
        ):
            fail("DEPLOY_JOURNAL_INVALID")
        try:
            decoded = base64.b64decode(slot["valueBase64"], validate=True)
        except (ValueError, binascii.Error):
            fail("DEPLOY_JOURNAL_INVALID")
        if hashlib.sha256(decoded).hexdigest() != slot["sha256"] or (not slot["existed"] and decoded != b""):
            fail("DEPLOY_JOURNAL_INVALID")
    if {slot["name"] for slot in value["slots"]} != {"current.state", "previous.state", "attempt.state"}:
        fail("DEPLOY_JOURNAL_INVALID")
    before_summary = hashlib.sha256(canonical_json([
        {"existed": slot["existed"], "name": slot["name"], "sha256": slot["sha256"]}
        for slot in value["slots"]
    ]).encode("ascii")).hexdigest()
    if before_summary != value["beforeImageSummary"]:
        fail("DEPLOY_JOURNAL_INVALID")
    backup_path = value["databaseBackupPath"]
    backup_checksum = value["databaseBackupChecksum"]
    if (backup_path, backup_checksum) != ("none", "none") and (
        not isinstance(backup_path, str) or not backup_path.startswith("/")
        or not isinstance(backup_checksum, str) or FINGERPRINT_PATTERN.fullmatch(backup_checksum) is None
    ):
        fail("DEPLOY_JOURNAL_INVALID")
    current = next(slot for slot in value["slots"] if slot["name"] == "current.state")
    if not current["existed"]:
        fail("DEPLOY_JOURNAL_INVALID")
    current_raw = base64.b64decode(current["valueBase64"], validate=True)
    if not current_raw.startswith(f"protocolVersion={value['originalProtocolVersion']}\n".encode("ascii")):
        fail("DEPLOY_JOURNAL_INVALID")
    return value


def begin_deploy_journal(journal: Path, slots: list[Path], candidate_path: Path, target_summary: str) -> None:
    if journal.exists() or journal.is_symlink() or FINGERPRINT_PATTERN.fullmatch(target_summary) is None:
        fail("DEPLOY_JOURNAL_ACTIVE")
    before = [deploy_journal_slot(slot) for slot in slots]
    try:
        candidate = validate_state(json.loads(candidate_path.read_text(encoding="ascii")))
    except (OSError, UnicodeError, ValueError):
        fail("DEPLOY_JOURNAL_INVALID")
    current = next(slot for slot in before if slot["name"] == "current.state")
    if not current["existed"]:
        fail("DEPLOY_JOURNAL_INVALID")
    current_raw = base64.b64decode(current["valueBase64"], validate=True)
    match = re.match(rb"protocolVersion=([345])\n", current_raw)
    if match is None:
        fail("DEPLOY_JOURNAL_INVALID")
    before_summary = hashlib.sha256(canonical_json([
        {"existed": slot["existed"], "name": slot["name"], "sha256": slot["sha256"]}
        for slot in before
    ]).encode("ascii")).hexdigest()
    write_deploy_journal(journal, {
        "beforeImageSummary": before_summary,
        "databaseBackupChecksum": candidate["databaseBackupChecksum"],
        "databaseBackupPath": candidate["databaseBackupPath"],
        "format": DEPLOY_JOURNAL_FORMAT,
        "originalProtocolVersion": int(match.group(1)),
        "slots": before,
        "stage": "before-attempt",
        "targetSchemaMax": candidate["imageSchemaMax"],
        "targetSchemaMin": candidate["imageSchemaMin"],
        "targetSchemaVersion": candidate["schemaVersion"],
        "targetSummary": target_summary,
    })


def advance_deploy_journal(journal: Path, stage: str) -> None:
    value = load_deploy_journal(journal)
    if value is None or stage not in DEPLOY_JOURNAL_STAGES:
        fail("DEPLOY_JOURNAL_INVALID")
    value["stage"] = stage
    write_deploy_journal(journal, value)


def write_incomplete_marker(destination: Path, journal_value: dict[str, Any]) -> None:
    value = {
        "beforeImageSummary": journal_value["beforeImageSummary"],
        "databaseBackupChecksum": journal_value["databaseBackupChecksum"],
        "databaseBackupPath": journal_value["databaseBackupPath"],
        "format": "kinvest-deploy-incomplete-v1",
        "stage": journal_value["stage"],
        "targetSchemaMax": journal_value["targetSchemaMax"],
        "targetSchemaMin": journal_value["targetSchemaMin"],
        "targetSchemaVersion": journal_value["targetSchemaVersion"],
        "targetSummary": journal_value["targetSummary"],
    }
    write_deploy_journal(destination, value)


def load_incomplete_marker(destination: Path) -> dict[str, Any] | None:
    validate_atomic_destination(destination, "DEPLOY_INCOMPLETE_MARKER_INVALID")
    try:
        info = destination.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        fail("DEPLOY_INCOMPLETE_MARKER_INVALID")
    if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600 or info.st_uid != os.geteuid() or info.st_size > 4096:
        fail("DEPLOY_INCOMPLETE_MARKER_INVALID")
    try:
        raw = destination.read_bytes()
        value = json.loads(raw.decode("ascii"))
    except (OSError, UnicodeError, ValueError):
        fail("DEPLOY_INCOMPLETE_MARKER_INVALID")
    value = require_exact_keys(value, {
        "beforeImageSummary", "databaseBackupChecksum", "databaseBackupPath", "format",
        "stage", "targetSchemaMax", "targetSchemaMin", "targetSchemaVersion", "targetSummary",
    }, "DEPLOY_INCOMPLETE_MARKER_INVALID")
    if (
        raw != (canonical_json(value) + "\n").encode("ascii")
        or value["format"] != "kinvest-deploy-incomplete-v1"
        or value["stage"] not in DEPLOY_JOURNAL_STAGES
        or not isinstance(value["beforeImageSummary"], str)
        or FINGERPRINT_PATTERN.fullmatch(value["beforeImageSummary"]) is None
        or type(value["targetSchemaVersion"]) is not int
        or type(value["targetSchemaMin"]) is not int
        or type(value["targetSchemaMax"]) is not int
        or not value["targetSchemaMin"] <= value["targetSchemaVersion"] <= value["targetSchemaMax"]
        or not isinstance(value["targetSummary"], str)
        or FINGERPRINT_PATTERN.fullmatch(value["targetSummary"]) is None
    ):
        fail("DEPLOY_INCOMPLETE_MARKER_INVALID")
    backup_path = value["databaseBackupPath"]
    backup_checksum = value["databaseBackupChecksum"]
    if (backup_path, backup_checksum) != ("none", "none") and (
        not isinstance(backup_path, str) or not backup_path.startswith("/")
        or not isinstance(backup_checksum, str) or FINGERPRINT_PATTERN.fullmatch(backup_checksum) is None
    ):
        fail("DEPLOY_INCOMPLETE_MARKER_INVALID")
    return value


def incomplete_marker_backup_reference(destination: Path) -> dict[str, str]:
    value = load_incomplete_marker(destination)
    if value is None:
        fail("DEPLOY_INCOMPLETE_MARKER_BACKUP_INVALID")
    backup_path = value["databaseBackupPath"]
    backup_checksum = value["databaseBackupChecksum"]
    if (backup_path, backup_checksum) == ("none", "none"):
        return {"databaseBackupChecksum": "none", "databaseBackupPath": "none"}
    path = Path(backup_path)
    descriptor = None
    try:
        root_info = BACKUP_ROOT.lstat()
        file_info = path.lstat()
        if (
            path.parent != BACKUP_ROOT
            or not stat.S_ISDIR(root_info.st_mode)
            or stat.S_IMODE(root_info.st_mode) != 0o700
            or root_info.st_uid != BACKUP_UID
            or root_info.st_gid != BACKUP_GID
            or not stat.S_ISREG(file_info.st_mode)
            or stat.S_IMODE(file_info.st_mode) != 0o600
            or file_info.st_uid != BACKUP_UID
            or file_info.st_gid != BACKUP_GID
        ):
            fail("DEPLOY_INCOMPLETE_MARKER_BACKUP_INVALID")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        opened = os.fstat(descriptor)
        if (opened.st_dev, opened.st_ino) != (file_info.st_dev, file_info.st_ino):
            fail("DEPLOY_INCOMPLETE_MARKER_BACKUP_INVALID")
        digest = hashlib.sha256()
        while chunk := os.read(descriptor, 1024 * 1024):
            digest.update(chunk)
        if digest.hexdigest() != backup_checksum:
            fail("DEPLOY_INCOMPLETE_MARKER_BACKUP_INVALID")
    except OSError:
        fail("DEPLOY_INCOMPLETE_MARKER_BACKUP_INVALID")
    finally:
        if descriptor is not None:
            os.close(descriptor)
    return {"databaseBackupChecksum": backup_checksum, "databaseBackupPath": backup_path}


def clear_incomplete_marker(destination: Path) -> None:
    if not load_incomplete_marker(destination):
        return
    try:
        destination.unlink()
        fsync_directory(destination.parent)
    except OSError:
        fail("DEPLOY_INCOMPLETE_MARKER_INVALID")


def reconcile_deploy_journal(journal: Path, slots: list[Path], incomplete_marker: Path | None = None) -> bool:
    value = load_deploy_journal(journal)
    if value is None:
        return False
    by_name = {slot.name: slot for slot in slots}
    if set(by_name) != {"current.state", "previous.state", "attempt.state"}:
        fail("DEPLOY_JOURNAL_INVALID")
    try:
        for saved in value["slots"]:
            destination = by_name[saved["name"]]
            decoded = base64.b64decode(saved["valueBase64"], validate=True)
            if saved["existed"]:
                temporary = write_temporary(destination.parent, f".{destination.name}.journal-restore.", decoded, saved["mode"], saved["uid"], saved["gid"])
                try:
                    os.replace(temporary, destination)
                except Exception:
                    os.unlink(temporary)
                    raise
            else:
                destination.unlink(missing_ok=True)
        fsync_directory(journal.parent)
        if incomplete_marker is not None:
            write_incomplete_marker(incomplete_marker, value)
        journal.unlink()
        fsync_directory(journal.parent)
    except OSError:
        fail("DEPLOY_JOURNAL_RECONCILE_FAILED")
    return True


def commit_deploy_journal(journal: Path) -> None:
    if load_deploy_journal(journal) is None:
        fail("DEPLOY_JOURNAL_INVALID")
    try:
        fsync_directory(journal.parent)
        journal.unlink()
        fsync_directory(journal.parent)
    except OSError:
        fail("DEPLOY_JOURNAL_COMMIT_FAILED")


def read_version_ledger(destination: Path) -> dict[str, dict[str, str]]:
    validate_atomic_destination(destination, "DEPLOY_V3_LEDGER_PATH_INVALID")
    if not destination.exists():
        return empty_version_ledger()
    try:
        info = destination.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_uid != os.geteuid()
            or info.st_size > 64 * 1024
        ):
            fail("DEPLOY_V3_LEDGER_INVALID")
        raw = destination.read_text(encoding="ascii")
        value = json.loads(raw)
    except (OSError, UnicodeError, ValueError):
        fail("DEPLOY_V3_LEDGER_INVALID")
    normalized = validate_version_ledger(value)
    if raw != canonical_json(normalized) + "\n":
        fail("DEPLOY_V3_LEDGER_INVALID")
    return normalized


def check_version_ledger(destination: Path, candidate: Any) -> dict[str, dict[str, str]]:
    ledger = read_version_ledger(destination)
    for field, (version, fingerprint) in candidate_version_fingerprints(candidate).items():
        recorded = ledger[field].get(version)
        if recorded is not None and recorded != fingerprint:
            fail("SECRET_VERSION_REUSE_CONFLICT")
    return ledger


def commit_version_ledger(destination: Path, candidate: Any) -> None:
    ledger = check_version_ledger(destination, candidate)
    for field, (version, fingerprint) in candidate_version_fingerprints(candidate).items():
        ledger[field][version] = fingerprint
    normalized = validate_version_ledger(ledger)
    atomic_replace_bytes(
        destination,
        (canonical_json(normalized) + "\n").encode("ascii"),
        "DEPLOY_V3_LEDGER_WRITE_FAILED",
    )


def remove_bundle(bundle_id: str, bundle_root: Path = BUNDLE_ROOT) -> None:
    if BUNDLE_ID_PATTERN.fullmatch(bundle_id) is None:
        fail("DEPLOY_V3_BUNDLE_ID_INVALID")
    bundle_path = bundle_root / bundle_id
    try:
        info = bundle_path.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != BUNDLE_UID or info.st_gid != BUNDLE_GID:
            fail("DEPLOY_V3_BUNDLE_UNSAFE")
        os.chmod(bundle_path, 0o700)
        allowed = {"manifest.json", "admin-password-verifier", "device-token-hmac-key"}
        children = {child.name for child in bundle_path.iterdir()}
        if children != allowed:
            fail("DEPLOY_V3_BUNDLE_UNSAFE")
        for name in allowed:
            child = bundle_path / name
            child_info = child.lstat()
            if not stat.S_ISREG(child_info.st_mode):
                fail("DEPLOY_V3_BUNDLE_UNSAFE")
            child.unlink()
        bundle_path.rmdir()
    except FileNotFoundError:
        return
    except OSError:
        fail("DEPLOY_V3_BUNDLE_REMOVE_FAILED")


def make_state(base: Any, argv: list[str]) -> dict[str, Any]:
    expected_argv = 11 if IS_V4 else 8
    if not isinstance(base, dict) or len(argv) != expected_argv:
        fail("DEPLOY_V3_STATE_INVALID")
    runtime_image_id, schema, minimum, maximum, bundle_id, backup_path, backup_checksum, deployed_at = argv[:8]
    try:
        numeric_schema, numeric_minimum, numeric_maximum = int(schema), int(minimum), int(maximum)
    except ValueError:
        fail("DEPLOY_V3_STATE_INVALID")
    required = {
        "imageDigest", "commit", "secretProviderMode", "secretVersionIds",
        "secretMaterialFingerprints", "releaseRecordSchemaVersion",
        "verificationRunId", "artifactSource",
    }
    if not required.issubset(base):
        fail("DEPLOY_V3_STATE_INVALID")
    result = {
        "protocolVersion": 5 if IS_V4 else 4,
        "imageDigest": base["imageDigest"],
        "runtimeImageId": runtime_image_id,
        "commit": base["commit"],
        "schemaVersion": numeric_schema,
        "imageSchemaMin": numeric_minimum,
        "imageSchemaMax": numeric_maximum,
        "secretProviderMode": base["secretProviderMode"],
        "secretVersionIds": base["secretVersionIds"],
        "secretBundleId": bundle_id,
        "secretMaterialFingerprints": base["secretMaterialFingerprints"],
        "releaseRecordSchemaVersion": base["releaseRecordSchemaVersion"],
        "verificationRunId": base["verificationRunId"],
        "artifactSource": base["artifactSource"],
        "databaseBackupPath": backup_path,
        "databaseBackupChecksum": backup_checksum,
        "deployedAt": deployed_at,
    }
    if IS_V4:
        image_contract, proxy_json, proxy_checksum = argv[8:]
        try:
            proxies = json.loads(proxy_json)
        except ValueError:
            fail("DEPLOY_V4_STATE_INVALID")
        if canonical_json(proxies) != proxy_json:
            fail("DEPLOY_V4_STATE_INVALID")
        result.update({
            "accessControlMode": base.get("accessControlMode"),
            "imageAccessControlContract": int(image_contract),
            "trustedProxyAddresses": proxies,
            "trustedProxyConfigChecksum": proxy_checksum,
        })
    return validate_state(result)


def validate_approved_secret_state(value: Any) -> dict[str, Any]:
    access_fields = {
        "accessControlMode", "imageAccessControlContract",
        "trustedProxyAddresses", "trustedProxyConfigChecksum",
    } if IS_V4 else set()
    value = require_exact_keys(
        value,
        {
            "secretProviderMode",
            "secretVersionIds",
            "secretMaterialFingerprints",
            "secretBundleId",
        } | access_fields,
        "DEPLOY_V3_RECOVERY_STATE_INVALID",
    )
    provider = value["secretProviderMode"]
    versions = validate_secret_versions(value["secretVersionIds"], provider)
    fingerprints = validate_fingerprints(value["secretMaterialFingerprints"], provider)
    bundle_id = value["secretBundleId"]
    if provider == "disabled":
        if bundle_id != "none":
            fail("DEPLOY_V3_RECOVERY_STATE_INVALID")
    elif BUNDLE_ID_PATTERN.fullmatch(bundle_id) is None:
        fail("DEPLOY_V3_RECOVERY_STATE_INVALID")
    result = {
        "secretProviderMode": provider,
        "secretVersionIds": versions,
        "secretMaterialFingerprints": fingerprints,
        "secretBundleId": bundle_id,
    }
    if IS_V4:
        candidate = validate_state({
            **{
                "protocolVersion": 5,
                "imageDigest": f"ghcr.io/zwphhxx/kinvest@sha256:{'0' * 64}",
                "runtimeImageId": f"sha256:{'0' * 64}",
                "commit": "0" * 40,
                "schemaVersion": 0,
                "imageSchemaMin": 0,
                "imageSchemaMax": 0,
                "releaseRecordSchemaVersion": 2,
                "verificationRunId": "0",
                "artifactSource": "ghcr-public",
                "databaseBackupPath": "none",
                "databaseBackupChecksum": "none",
                "deployedAt": "2026-01-01T00:00:00Z",
            },
            **result,
            **{field: value[field] for field in access_fields},
        })
        result.update({field: candidate[field] for field in access_fields})
    return result


def make_recovery_state(
    value: Any,
    restore: bool = False,
    schema_version: str | None = None,
    backup_path: str | None = None,
    backup_checksum: str | None = None,
    image_minimum: str | None = None,
    image_maximum: str | None = None,
) -> dict[str, Any]:
    value = require_exact_keys(value, {"original", "approved"}, "DEPLOY_V3_RECOVERY_STATE_INVALID")
    original = validate_state(value["original"])
    approved = validate_approved_secret_state(value["approved"])
    protected_fields = [
        "secretProviderMode", "secretVersionIds", "secretMaterialFingerprints",
    ]
    if IS_V4:
        protected_fields.extend([
            "accessControlMode", "imageAccessControlContract",
            "trustedProxyAddresses", "trustedProxyConfigChecksum",
        ])
    if restore and any(approved[field] != original[field] for field in protected_fields):
        fail("RESTORE_STATE_MISMATCH")
    if IS_V4 and not restore and any(
        approved[field] != original[field]
        for field in (*protected_fields, "secretBundleId")
    ):
        fail("RECOVERY_SECURITY_STATE_MISMATCH")
    recovered = {**original, **approved}
    if schema_version is not None:
        try:
            recovered["schemaVersion"] = int(schema_version)
        except ValueError:
            fail("DEPLOY_V3_RECOVERY_STATE_INVALID")
        recovered["databaseBackupPath"] = backup_path
        recovered["databaseBackupChecksum"] = backup_checksum
    if image_minimum is not None and image_maximum is not None:
        try:
            recovered["imageSchemaMin"] = int(image_minimum)
            recovered["imageSchemaMax"] = int(image_maximum)
        except ValueError:
            fail("DEPLOY_V3_RECOVERY_STATE_INVALID")
    return validate_state(recovered)


def resolve_intent(value: Any) -> dict[str, Any]:
    value = require_exact_keys(value, {"intent", "request", "current", "previous"}, "DEPLOY_V3_INTENT_STATE_INVALID")
    intent = value["intent"]
    request_fields = {
        "imageDigest", "commit", "secretProviderMode", "secretVersionIds", "secretMaterialFingerprints",
    }
    if IS_V4:
        request_fields.add("accessControlMode")
    request = require_exact_keys(
        value["request"],
        request_fields,
        "DEPLOY_V3_INTENT_STATE_INVALID",
    )
    current = validate_state(value["current"])
    provider = request["secretProviderMode"]
    versions = validate_secret_versions(request["secretVersionIds"], provider)
    fingerprints = validate_fingerprints(request["secretMaterialFingerprints"], provider)
    requested_access = request.get("accessControlMode", "disabled")
    if requested_access not in {"disabled", "device-approval"}:
        fail("DEPLOY_V4_INTENT_STATE_INVALID")
    if IS_V4 and intent == "FORWARD" and current["accessControlMode"] == "device-approval" and requested_access == "disabled":
        fail("ACCESS_CONTROL_DOWNGRADE_FORBIDDEN")
    if current["secretProviderMode"] == "github-tmpfs-v1" and provider == "disabled":
        fail("SECRET_PROVIDER_DOWNGRADE_FORBIDDEN")
    check_version_reuse(current, request)
    if value["previous"] is not None:
        check_version_reuse(validate_state(value["previous"]), request)
    if intent == "FORWARD":
        return {
            "intent": intent,
            "operations": ["resolve-image", "preflight", "backup", "compose", "health", "state"],
            "secretMaterialFingerprints": fingerprints,
            "secretVersionIds": versions,
            **({"accessControlMode": requested_access} if IS_V4 else {}),
        }
    if intent == "ROLLBACK":
        if value["previous"] is None:
            fail("ROLLBACK_STATE_UNAVAILABLE")
        if IS_V4 and (
            provider != current["secretProviderMode"]
            or versions != current["secretVersionIds"]
            or fingerprints != current["secretMaterialFingerprints"]
            or requested_access != current["accessControlMode"]
        ):
            fail("ROLLBACK_SECURITY_STATE_MISMATCH")
        target = validate_state(value["previous"])
        if request["imageDigest"] != target["imageDigest"] or request["commit"] != target["commit"]:
            fail("ROLLBACK_STATE_MISMATCH")
        if not target["imageSchemaMin"] <= current["schemaVersion"] <= target["imageSchemaMax"]:
            fail("ROLLBACK_REQUIRES_DB_RESTORE")
        target = {
            **target,
            "secretProviderMode": current["secretProviderMode"] if IS_V4 else provider,
            "secretVersionIds": current["secretVersionIds"] if IS_V4 else versions,
            "secretMaterialFingerprints": current["secretMaterialFingerprints"] if IS_V4 else fingerprints,
        }
        if IS_V4:
            target.update({
                "accessControlMode": current["accessControlMode"],
                "imageAccessControlContract": current["imageAccessControlContract"],
                "trustedProxyAddresses": current["trustedProxyAddresses"],
                "trustedProxyConfigChecksum": current["trustedProxyConfigChecksum"],
            })
        return {
            "intent": intent,
            "operations": ["preflight", "backup", "compose", "health", "state"],
            "secretMaterialFingerprints": current["secretMaterialFingerprints"] if IS_V4 else fingerprints,
            "secretVersionIds": current["secretVersionIds"] if IS_V4 else versions,
            **({"accessControlMode": current["accessControlMode"]} if IS_V4 else {}),
            "target": target,
        }
    if intent == "RESTORE":
        if (
            request["imageDigest"] != current["imageDigest"]
            or request["commit"] != current["commit"]
            or provider != current["secretProviderMode"]
            or versions != current["secretVersionIds"]
            or fingerprints != current["secretMaterialFingerprints"]
            or (IS_V4 and requested_access != current["accessControlMode"])
        ):
            fail("RESTORE_STATE_MISMATCH")
        return {
            "intent": intent,
            "operations": ["preflight", "compose", "health", "state"],
            "secretMaterialFingerprints": fingerprints,
            "secretVersionIds": versions,
            "target": current,
        }
    fail("DEPLOY_V3_INTENT_INVALID")


def validate_network_config(path: Path) -> dict[str, Any]:
    try:
        info = path.lstat()
        expected_uid = int(os.environ.get("KINVEST_V4_TEST_ROOT_UID", "0"))
        if (
            not path.is_absolute()
            or not stat.S_ISREG(info.st_mode)
            or path.is_symlink()
            or info.st_uid != expected_uid
            or stat.S_IMODE(info.st_mode) != 0o600
            or info.st_size > 1024
        ):
            fail("DEPLOY_V4_PROXY_CONFIG_INVALID")
        raw = path.read_bytes()
        text = raw.decode("ascii")
    except (OSError, UnicodeError, ValueError):
        fail("DEPLOY_V4_PROXY_CONFIG_INVALID")
    lines = text.splitlines()
    expected_names = ("KINVEST_WEB_NETWORK", "KINVEST_NGINX_CONTAINER", "KINVEST_NGINX_IPV4")
    if not text.endswith("\n") or len(lines) != 3:
        fail("DEPLOY_V4_PROXY_CONFIG_INVALID")
    values = {}
    for name, line in zip(expected_names, lines):
        prefix = name + "="
        if not line.startswith(prefix):
            fail("DEPLOY_V4_PROXY_CONFIG_INVALID")
        values[name] = line[len(prefix):]
    if values["KINVEST_WEB_NETWORK"] != "web" or values["KINVEST_NGINX_CONTAINER"] != "nginx":
        fail("DEPLOY_V4_PROXY_CONFIG_INVALID")
    try:
        ip = str(ipaddress.IPv4Address(values["KINVEST_NGINX_IPV4"]))
    except ipaddress.AddressValueError:
        fail("DEPLOY_V4_PROXY_CONFIG_INVALID")
    if ip != values["KINVEST_NGINX_IPV4"]:
        fail("DEPLOY_V4_PROXY_CONFIG_INVALID")
    return {
        "checksum": hashlib.sha256(raw).hexdigest(),
        "container": "nginx",
        "ip": ip,
        "network": "web",
        "trustedProxyAddresses": [ip],
    }


def read_json_stdin() -> Any:
    raw = sys.stdin.read(64 * 1024 + 1)
    if len(raw) > 64 * 1024:
        fail("DEPLOY_V3_INPUT_TOO_LARGE")
    try:
        return json.loads(raw)
    except ValueError:
        fail("DEPLOY_V3_INPUT_INVALID")


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        fail("DEPLOY_V3_USAGE")
    command = argv[1]
    if command == "validate-payload":
        metadata, admin_material, hmac_material = read_payload()
        try:
            sys.stdout.write(canonical_json(metadata) + "\n")
        finally:
            for material in (admin_material, hmac_material):
                if material is not None:
                    for index in range(len(material)):
                        material[index] = 0
        return 0
    if command == "prepare":
        metadata, admin_material, hmac_material = read_payload()
        try:
            prepared = build_bundle(metadata, admin_material, hmac_material)
            sys.stdout.write(canonical_json(prepared) + "\n")
        finally:
            for material in (admin_material, hmac_material):
                if material is not None:
                    for index in range(len(material)):
                        material[index] = 0
        return 0
    if command == "canonical-state":
        sys.stdout.write(state_text(read_json_stdin()))
        return 0
    if command == "parse-state":
        if len(argv) != 2:
            fail("DEPLOY_V3_USAGE")
        raw = sys.stdin.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024:
            fail("DEPLOY_V3_STATE_INVALID")
        sys.stdout.write(canonical_json(state_from_text(raw)) + "\n")
        return 0
    if command == "atomic-legacy-state" and len(argv) == 3:
        raw = sys.stdin.read(64 * 1024 + 1)
        if len(raw) > 64 * 1024 or not raw.startswith("protocolVersion=3\n"):
            fail("DEPLOY_V3_STATE_INVALID")
        try:
            raw.encode("ascii")
        except UnicodeError:
            fail("DEPLOY_V3_STATE_INVALID")
        state_from_text(raw)
        atomic_replace_bytes(
            Path(argv[2]),
            raw.encode("ascii"),
            "DEPLOY_V3_STATE_WRITE_FAILED",
        )
        return 0
    if command == "check-version-reuse":
        value = read_json_stdin()
        value = require_exact_keys(value, {"current", "candidate"}, "DEPLOY_V3_STATE_INVALID")
        check_version_reuse(value["current"], value["candidate"])
        sys.stdout.write("DEPLOY_V3_VERSION_REUSE_OK\n")
        return 0
    if command in {"ledger-check", "ledger-commit"} and len(argv) == 3:
        destination = Path(argv[2])
        candidate = read_json_stdin()
        if command == "ledger-check":
            check_version_ledger(destination, candidate)
            sys.stdout.write("DEPLOY_V3_VERSION_LEDGER_OK\n")
        else:
            commit_version_ledger(destination, candidate)
        return 0
    if command == "resolve-intent":
        sys.stdout.write(canonical_json(resolve_intent(read_json_stdin())) + "\n")
        return 0
    if command == "json-field" and len(argv) == 3:
        value = read_json_stdin()
        if not isinstance(value, dict) or argv[2] not in value:
            fail("DEPLOY_V3_FIELD_INVALID")
        item = value[argv[2]]
        if isinstance(item, (dict, list)):
            sys.stdout.write(canonical_json(item) + "\n")
        elif (isinstance(item, str) or type(item) is int) and "\n" not in str(item) and "\r" not in str(item):
            sys.stdout.write(str(item) + "\n")
        else:
            fail("DEPLOY_V3_FIELD_INVALID")
        return 0
    if command == "resolve-files" and len(argv) == 5:
        try:
            prepared = json.loads(Path(argv[2]).read_text(encoding="ascii"))
            current = json.loads(Path(argv[3]).read_text(encoding="ascii"))
            previous = None if argv[4] == "none" else json.loads(Path(argv[4]).read_text(encoding="ascii"))
        except (OSError, ValueError):
            fail("DEPLOY_V3_INTENT_STATE_INVALID")
        request_keys = [
            "imageDigest", "commit", "secretProviderMode",
            "secretVersionIds", "secretMaterialFingerprints",
        ]
        if IS_V4:
            request_keys.append("accessControlMode")
        request = {key: prepared[key] for key in request_keys}
        sys.stdout.write(canonical_json(resolve_intent({
            "intent": prepared["intent"], "request": request,
            "current": current, "previous": previous,
        })) + "\n")
        return 0
    if command == "make-state" and len(argv) == (13 if IS_V4 else 10):
        sys.stdout.write(canonical_json(make_state(read_json_stdin(), argv[2:])) + "\n")
        return 0
    if command == "validate-network-config" and len(argv) == 3 and IS_V4:
        sys.stdout.write(canonical_json(validate_network_config(Path(argv[2]))) + "\n")
        return 0
    if command == "make-recovery-state" and len(argv) in {2, 5}:
        result = make_recovery_state(
            read_json_stdin(),
            schema_version=argv[2] if len(argv) == 5 else None,
            backup_path=argv[3] if len(argv) == 5 else None,
            backup_checksum=argv[4] if len(argv) == 5 else None,
        )
        sys.stdout.write(canonical_json(result) + "\n")
        return 0
    if command == "make-restore-state" and len(argv) in {2, 5, 7}:
        result = make_recovery_state(
            read_json_stdin(),
            restore=True,
            schema_version=argv[2] if len(argv) in {5, 7} else None,
            backup_path=argv[5] if len(argv) == 7 else (argv[3] if len(argv) == 5 else None),
            backup_checksum=argv[6] if len(argv) == 7 else (argv[4] if len(argv) == 5 else None),
            image_minimum=argv[3] if len(argv) == 7 else None,
            image_maximum=argv[4] if len(argv) == 7 else None,
        )
        sys.stdout.write(canonical_json(result) + "\n")
        return 0
    if command == "atomic-state" and len(argv) == 3:
        atomic_write_state(Path(argv[2]), read_json_stdin())
        return 0
    if command == "reconcile-atomic-state" and len(argv) == 3:
        reconcile_atomic_state(Path(argv[2]))
        return 0
    if command == "begin-deploy-journal" and len(argv) == 8:
        begin_deploy_journal(Path(argv[2]), [Path(argv[3]), Path(argv[4]), Path(argv[5])], Path(argv[6]), argv[7])
        return 0
    if command == "advance-deploy-journal" and len(argv) == 4:
        advance_deploy_journal(Path(argv[2]), argv[3])
        return 0
    if command == "reconcile-deploy-journal" and len(argv) in {6, 7}:
        reconciled = reconcile_deploy_journal(
            Path(argv[2]),
            [Path(argv[3]), Path(argv[4]), Path(argv[5])],
            Path(argv[6]) if len(argv) == 7 else None,
        )
        sys.stdout.write("RECONCILED\n" if reconciled else "CLEAN\n")
        return 0
    if command == "commit-deploy-journal" and len(argv) == 3:
        commit_deploy_journal(Path(argv[2]))
        return 0
    if command == "check-incomplete-marker" and len(argv) == 3:
        sys.stdout.write("ACTIVE\n" if load_incomplete_marker(Path(argv[2])) else "CLEAN\n")
        return 0
    if command == "incomplete-marker-backup-reference" and len(argv) == 3:
        sys.stdout.write(canonical_json(incomplete_marker_backup_reference(Path(argv[2]))) + "\n")
        return 0
    if command == "clear-incomplete-marker" and len(argv) == 3:
        clear_incomplete_marker(Path(argv[2]))
        return 0
    if command == "remove-bundle" and len(argv) == 3:
        remove_bundle(argv[2])
        return 0
    fail("DEPLOY_V3_USAGE")


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except ContractError as error:
        sys.stderr.write(error.code + "\n")
        raise SystemExit(2)
    except Exception:
        sys.stderr.write(("DEPLOY_V4" if IS_V4 else "DEPLOY_V3") + "_INTERNAL_ERROR\n")
        raise SystemExit(1)
