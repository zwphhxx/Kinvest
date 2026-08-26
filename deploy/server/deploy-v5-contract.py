#!/usr/bin/env python3
"""Secret-safe deploy-v5 payload and joint deployment-state contract."""

from __future__ import annotations

import base64
import hashlib
import ipaddress
import json
import re
import sys
from datetime import datetime
from typing import Any


MAX_PAYLOAD_BYTES = 16 * 1024
MAX_LINE_BYTES = 6144
MAX_JSON_INPUT_BYTES = 128 * 1024
MAX_IFIND_MATERIAL_BYTES = 4096
VERSION_PATTERN = re.compile(r"^v[0-9]{8}-[0-9]{3}$")
DIGEST_PATTERN = re.compile(r"^ghcr\.io/zwphhxx/kinvest@sha256:[0-9a-f]{64}$")
IMAGE_ID_PATTERN = re.compile(r"^sha256:[0-9a-f]{64}$")
COMMIT_PATTERN = re.compile(r"^[0-9a-f]{40}$")
FINGERPRINT_PATTERN = re.compile(r"^[0-9a-f]{64}$")
BUNDLE_ID_PATTERN = re.compile(r"^[0-9a-f]{32}$")
TIMESTAMP_PATTERN = re.compile(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
)
IFIND_MATERIAL_PATTERN = re.compile(r"^[!-~]+$")

STATE_FIELDS_V5 = (
    "protocolVersion", "imageDigest", "runtimeImageId", "commit",
    "schemaVersion", "imageSchemaMin", "imageSchemaMax",
    "secretProviderMode", "secretVersionIds", "secretBundleId",
    "secretMaterialFingerprints", "accessControlMode",
    "imageAccessControlContract", "trustedProxyAddresses",
    "trustedProxyConfigChecksum", "releaseRecordSchemaVersion",
    "verificationRunId", "artifactSource", "databaseBackupPath",
    "databaseBackupChecksum", "deployedAt",
)
STATE_FIELDS_V6 = (
    "protocolVersion", "imageDigest", "runtimeImageId", "commit",
    "schemaVersion", "imageSchemaMin", "imageSchemaMax",
    "secretProviderMode", "secretVersionIds", "secretBundleId",
    "secretMaterialFingerprints", "accessControlMode",
    "imageAccessControlContract", "trustedProxyAddresses",
    "trustedProxyConfigChecksum", "ifindDiagnosticMode",
    "ifindRefreshTokenVersionId", "ifindSecretBundleId",
    "ifindSecretMaterialFingerprint", "releaseRecordSchemaVersion",
    "verificationRunId", "artifactSource", "databaseBackupPath",
    "databaseBackupChecksum", "deployedAt",
)


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
    decoded = bytearray()
    try:
        decoded = bytearray(base64.urlsafe_b64decode(raw + "=" * ((4 - len(raw) % 4) % 4)))
    except (ValueError, TypeError):
        fail(code)
    if base64.urlsafe_b64encode(decoded).decode("ascii").rstrip("=") != raw or (
        expected_size is not None and len(decoded) != expected_size
    ):
        clear(decoded)
        fail(code)
    return decoded


def clear(value: bytearray | None) -> None:
    if value is not None:
        for index in range(len(value)):
            value[index] = 0


def validate_admin_material(raw: str) -> bytearray:
    decoded = decode_base64url(raw, "DEPLOY_V5_ADMIN_MATERIAL_INVALID")
    try:
        if len(decoded) > 4096:
            fail("DEPLOY_V5_ADMIN_MATERIAL_INVALID")
        try:
            text = decoded.decode("utf-8")
        except UnicodeDecodeError:
            fail("DEPLOY_V5_ADMIN_MATERIAL_INVALID")
        value = parse_canonical_json(
            text,
            {"digest", "format", "n", "p", "r", "salt"},
            "DEPLOY_V5_ADMIN_MATERIAL_INVALID",
        )
        if (
            value["format"] != "kinvest-admin-scrypt-v1"
            or type(value["n"]) is not int or value["n"] != 65536
            or type(value["p"]) is not int or value["p"] != 1
            or type(value["r"]) is not int or value["r"] != 8
        ):
            fail("DEPLOY_V5_ADMIN_MATERIAL_INVALID")
        digest = decode_base64url(value["digest"], "DEPLOY_V5_ADMIN_MATERIAL_INVALID", 32)
        salt = decode_base64url(value["salt"], "DEPLOY_V5_ADMIN_MATERIAL_INVALID", 16)
        clear(digest)
        clear(salt)
        return decoded
    except Exception:
        clear(decoded)
        raise


def validate_hmac_material(raw: str) -> bytearray:
    decoded = decode_base64url(raw, "DEPLOY_V5_HMAC_MATERIAL_INVALID", 32)
    clear(decoded)
    return bytearray(raw.encode("ascii"))


def canonical_secret_versions(admin_version: str, hmac_version: str) -> dict[str, Any]:
    if VERSION_PATTERN.fullmatch(admin_version) is None or VERSION_PATTERN.fullmatch(hmac_version) is None:
        fail("DEPLOY_V5_VERSION_ID_INVALID")
    return {
        "adminPasswordVerifier": admin_version,
        "deviceTokenHmac": {"accepted": [hmac_version], "active": hmac_version},
    }


def validate_secret_versions(value: Any, provider: str) -> dict[str, Any]:
    if provider == "disabled":
        if value != {}:
            fail("DEPLOY_V5_SECRET_CONFIG_INVALID")
        return {}
    value = require_exact_keys(
        value,
        {"adminPasswordVerifier", "deviceTokenHmac"},
        "DEPLOY_V5_SECRET_CONFIG_INVALID",
    )
    device = require_exact_keys(
        value["deviceTokenHmac"], {"accepted", "active"},
        "DEPLOY_V5_SECRET_CONFIG_INVALID",
    )
    expected = canonical_secret_versions(value["adminPasswordVerifier"], device["active"])
    if value != expected:
        fail("DEPLOY_V5_SECRET_CONFIG_INVALID")
    return expected


def validate_fingerprints(value: Any, provider: str) -> dict[str, str]:
    if provider == "disabled":
        if value != {}:
            fail("DEPLOY_V5_FINGERPRINT_INVALID")
        return {}
    value = require_exact_keys(
        value,
        {"adminPasswordVerifier", "deviceTokenHmac"},
        "DEPLOY_V5_FINGERPRINT_INVALID",
    )
    if any(not isinstance(item, str) or FINGERPRINT_PATTERN.fullmatch(item) is None for item in value.values()):
        fail("DEPLOY_V5_FINGERPRINT_INVALID")
    return dict(value)


def validate_ifind_config(mode: Any, version: Any, fingerprint: Any, bundle_id: Any | None = None) -> tuple[str, str, str, str | None]:
    if mode not in {"disabled", "diagnostic"}:
        fail("DEPLOY_V5_IFIND_CONFIG_INVALID")
    if not all(isinstance(item, str) for item in (version, fingerprint)):
        fail("DEPLOY_V5_IFIND_CONFIG_INVALID")
    if bundle_id is not None and not isinstance(bundle_id, str):
        fail("DEPLOY_V5_IFIND_CONFIG_INVALID")
    if mode == "disabled":
        if version != "" or fingerprint != "" or (bundle_id is not None and bundle_id != "none"):
            fail("DEPLOY_V5_IFIND_CONFIG_INVALID")
    elif (
        VERSION_PATTERN.fullmatch(version) is None
        or FINGERPRINT_PATTERN.fullmatch(fingerprint) is None
        or (bundle_id is not None and BUNDLE_ID_PATTERN.fullmatch(bundle_id) is None)
    ):
        fail("DEPLOY_V5_IFIND_CONFIG_INVALID")
    return mode, version, fingerprint, bundle_id


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.buffer.read(MAX_PAYLOAD_BYTES + 1)
    if len(raw) > MAX_PAYLOAD_BYTES:
        fail("DEPLOY_V5_PAYLOAD_TOO_LARGE")
    if b"\r" in raw or not raw.endswith(b"\n"):
        fail("DEPLOY_V5_PAYLOAD_INVALID")
    lines = raw[:-1].split(b"\n")
    if len(lines) != 16 or any(len(line) > MAX_LINE_BYTES for line in lines):
        fail("DEPLOY_V5_PAYLOAD_INVALID")
    try:
        (
            magic, intent, image_digest, commit, provenance_raw, registry_raw,
            provider, admin_version, hmac_version, admin_raw, hmac_raw,
            policy_raw, ifind_mode, ifind_version, ifind_raw, end,
        ) = [line.decode("ascii") for line in lines]
    except UnicodeDecodeError:
        fail("DEPLOY_V5_PAYLOAD_INVALID")
    if magic != "KINVEST_DEPLOY_V5" or end != "EOF":
        fail("DEPLOY_V5_ENVELOPE_INVALID")
    if intent not in {"FORWARD", "ROLLBACK", "RESTORE"}:
        fail("DEPLOY_V5_INTENT_INVALID")
    if DIGEST_PATTERN.fullmatch(image_digest) is None:
        fail("DEPLOY_V5_DIGEST_INVALID")
    if COMMIT_PATTERN.fullmatch(commit) is None:
        fail("DEPLOY_V5_COMMIT_INVALID")
    provenance = parse_canonical_json(
        provenance_raw,
        {"artifactSource", "releaseRecordSchemaVersion", "verificationRunId"},
        "DEPLOY_V5_PROVENANCE_INVALID",
    )
    if (
        provenance["artifactSource"] != "ghcr-public"
        or type(provenance["releaseRecordSchemaVersion"]) is not int
        or provenance["releaseRecordSchemaVersion"] != 2
        or not isinstance(provenance["verificationRunId"], str)
        or re.fullmatch(r"[0-9]{1,20}", provenance["verificationRunId"]) is None
    ):
        fail("DEPLOY_V5_PROVENANCE_INVALID")
    registry = parse_canonical_json(
        registry_raw, {"host", "mode", "repository"}, "DEPLOY_V5_REGISTRY_INVALID"
    )
    if registry != {
        "host": "ghcr.io", "mode": "ghcr-public",
        "repository": "ghcr.io/zwphhxx/kinvest",
    }:
        fail("DEPLOY_V5_REGISTRY_INVALID")
    if provider not in {"disabled", "github-tmpfs-v1"}:
        fail("DEPLOY_V5_PROVIDER_INVALID")
    policy = parse_canonical_json(
        policy_raw, {"accessControlMode", "schemaVersion"}, "DEPLOY_V5_POLICY_INVALID"
    )
    if (
        type(policy["schemaVersion"]) is not int or policy["schemaVersion"] != 1
        or policy["accessControlMode"] not in {"disabled", "device-approval"}
        or (policy["accessControlMode"] == "device-approval" and provider != "github-tmpfs-v1")
    ):
        fail("DEPLOY_V5_POLICY_INVALID")

    admin_material = None
    hmac_material = None
    if provider == "disabled":
        if any((admin_version, hmac_version, admin_raw, hmac_raw)):
            fail("DEPLOY_V5_DISABLED_FIELDS_INVALID")
        versions: dict[str, Any] = {}
        fingerprints: dict[str, str] = {}
    else:
        versions = canonical_secret_versions(admin_version, hmac_version)
        admin_material = validate_admin_material(admin_raw)
        try:
            hmac_material = validate_hmac_material(hmac_raw)
        except Exception:
            clear(admin_material)
            raise
        fingerprints = {
            "adminPasswordVerifier": hashlib.sha256(admin_material).hexdigest(),
            "deviceTokenHmac": hashlib.sha256(hmac_material).hexdigest(),
        }

    ifind_material = None
    try:
        if ifind_mode == "disabled":
            if ifind_version or ifind_raw:
                fail("DEPLOY_V5_IFIND_CONFIG_INVALID")
            ifind_fingerprint = ""
        elif ifind_mode == "diagnostic":
            if VERSION_PATTERN.fullmatch(ifind_version) is None:
                fail("DEPLOY_V5_IFIND_CONFIG_INVALID")
            if (
                not ifind_raw or len(ifind_raw.encode("ascii")) > MAX_IFIND_MATERIAL_BYTES
                or IFIND_MATERIAL_PATTERN.fullmatch(ifind_raw) is None
            ):
                fail("DEPLOY_V5_IFIND_MATERIAL_INVALID")
            ifind_material = bytearray(ifind_raw.encode("ascii"))
            ifind_fingerprint = hashlib.sha256(ifind_material).hexdigest()
        else:
            fail("DEPLOY_V5_IFIND_CONFIG_INVALID")

        return {
            "accessControlMode": policy["accessControlMode"],
            "artifactSource": provenance["artifactSource"],
            "commit": commit,
            "ifindDiagnosticMode": ifind_mode,
            "ifindRefreshTokenVersionId": ifind_version,
            "ifindSecretMaterialFingerprint": ifind_fingerprint,
            "imageDigest": image_digest,
            "intent": intent,
            "registryHost": registry["host"],
            "registryMode": registry["mode"],
            "releaseRecordSchemaVersion": provenance["releaseRecordSchemaVersion"],
            "runtimePolicy": policy,
            "secretMaterialFingerprints": fingerprints,
            "secretProviderMode": provider,
            "secretVersionIds": versions,
            "verificationRunId": provenance["verificationRunId"],
        }
    finally:
        clear(admin_material)
        clear(hmac_material)
        clear(ifind_material)


def validate_state(value: Any) -> dict[str, Any]:
    value = require_exact_keys(value, set(STATE_FIELDS_V6), "DEPLOY_V5_STATE_INVALID")
    if value["protocolVersion"] != 6 or type(value["protocolVersion"]) is not int:
        fail("DEPLOY_V5_STATE_INVALID")
    if DIGEST_PATTERN.fullmatch(value["imageDigest"]) is None:
        fail("DEPLOY_V5_STATE_INVALID")
    if IMAGE_ID_PATTERN.fullmatch(value["runtimeImageId"]) is None:
        fail("DEPLOY_V5_STATE_INVALID")
    if COMMIT_PATTERN.fullmatch(value["commit"]) is None:
        fail("DEPLOY_V5_STATE_INVALID")
    for field in ("schemaVersion", "imageSchemaMin", "imageSchemaMax"):
        if type(value[field]) is not int or value[field] < 0:
            fail("DEPLOY_V5_STATE_INVALID")
    if not value["imageSchemaMin"] <= value["schemaVersion"] <= value["imageSchemaMax"]:
        fail("DEPLOY_V5_STATE_INVALID")
    provider = value["secretProviderMode"]
    if provider not in {"disabled", "github-tmpfs-v1"}:
        fail("DEPLOY_V5_STATE_INVALID")
    versions = validate_secret_versions(value["secretVersionIds"], provider)
    fingerprints = validate_fingerprints(value["secretMaterialFingerprints"], provider)
    bundle_id = value["secretBundleId"]
    if provider == "disabled":
        if bundle_id != "none":
            fail("DEPLOY_V5_STATE_INVALID")
    elif not isinstance(bundle_id, str) or BUNDLE_ID_PATTERN.fullmatch(bundle_id) is None:
        fail("DEPLOY_V5_STATE_INVALID")
    access_mode = value["accessControlMode"]
    if access_mode not in {"disabled", "device-approval"}:
        fail("DEPLOY_V5_STATE_INVALID")
    if type(value["imageAccessControlContract"]) is not int or value["imageAccessControlContract"] not in {0, 1}:
        fail("DEPLOY_V5_STATE_INVALID")
    if access_mode == "device-approval" and (provider != "github-tmpfs-v1" or value["imageAccessControlContract"] != 1):
        fail("DEPLOY_V5_STATE_INVALID")
    proxies = value["trustedProxyAddresses"]
    if not isinstance(proxies, list) or any(not isinstance(item, str) for item in proxies):
        fail("DEPLOY_V5_STATE_INVALID")
    try:
        normalized_proxies = sorted({str(ipaddress.IPv4Address(item)) for item in proxies})
    except ipaddress.AddressValueError:
        fail("DEPLOY_V5_STATE_INVALID")
    if proxies != normalized_proxies or (access_mode == "device-approval" and not proxies):
        fail("DEPLOY_V5_STATE_INVALID")
    proxy_checksum = value["trustedProxyConfigChecksum"]
    if not isinstance(proxy_checksum, str) or (
        access_mode == "device-approval" and FINGERPRINT_PATTERN.fullmatch(proxy_checksum) is None
    ) or (access_mode == "disabled" and proxy_checksum not in {""} and FINGERPRINT_PATTERN.fullmatch(proxy_checksum) is None):
        fail("DEPLOY_V5_STATE_INVALID")
    try:
        ifind_mode, ifind_version, ifind_fingerprint, ifind_bundle = validate_ifind_config(
            value["ifindDiagnosticMode"], value["ifindRefreshTokenVersionId"],
            value["ifindSecretMaterialFingerprint"], value["ifindSecretBundleId"],
        )
    except ContractError:
        fail("DEPLOY_V5_STATE_INVALID")
    if type(value["releaseRecordSchemaVersion"]) is not int or value["releaseRecordSchemaVersion"] != 2:
        fail("DEPLOY_V5_STATE_INVALID")
    if not isinstance(value["verificationRunId"], str) or re.fullmatch(r"[0-9]{1,20}", value["verificationRunId"]) is None:
        fail("DEPLOY_V5_STATE_INVALID")
    if value["artifactSource"] != "ghcr-public":
        fail("DEPLOY_V5_STATE_INVALID")
    backup_path = value["databaseBackupPath"]
    backup_checksum = value["databaseBackupChecksum"]
    if (backup_path, backup_checksum) != ("none", "none") and (
        not isinstance(backup_path, str)
        or not backup_path.startswith("/root/docker/kinvest/backups/")
        or not isinstance(backup_checksum, str)
        or FINGERPRINT_PATTERN.fullmatch(backup_checksum) is None
    ):
        fail("DEPLOY_V5_STATE_INVALID")
    deployed_at = value["deployedAt"]
    if not isinstance(deployed_at, str) or TIMESTAMP_PATTERN.fullmatch(deployed_at) is None:
        fail("DEPLOY_V5_STATE_INVALID")
    try:
        datetime.strptime(deployed_at, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        fail("DEPLOY_V5_STATE_INVALID")
    return {
        **value,
        "secretVersionIds": versions,
        "secretMaterialFingerprints": fingerprints,
        "trustedProxyAddresses": normalized_proxies,
        "ifindDiagnosticMode": ifind_mode,
        "ifindRefreshTokenVersionId": ifind_version,
        "ifindSecretBundleId": ifind_bundle,
        "ifindSecretMaterialFingerprint": ifind_fingerprint,
    }


def state_to_text(value: Any) -> str:
    state = validate_state(value)
    lines = []
    for field in STATE_FIELDS_V6:
        item = state[field]
        rendered = canonical_json(item) if isinstance(item, (dict, list)) else str(item)
        if "\n" in rendered or "\r" in rendered:
            fail("DEPLOY_V5_STATE_INVALID")
        lines.append(f"{field}={rendered}")
    return "\n".join(lines) + "\n"


def parse_state_text(raw: str) -> dict[str, Any]:
    if "\r" in raw or not raw.endswith("\n"):
        fail("DEPLOY_V5_STATE_INVALID")
    lines = raw[:-1].split("\n")
    if lines and lines[0] == "protocolVersion=5":
        fields = STATE_FIELDS_V5
        migrating = True
    elif lines and lines[0] == "protocolVersion=6":
        fields = STATE_FIELDS_V6
        migrating = False
    else:
        fail("DEPLOY_V5_STATE_INVALID")
    if len(lines) != len(fields):
        fail("DEPLOY_V5_STATE_INVALID")
    value: dict[str, Any] = {}
    integer_fields = {
        "protocolVersion", "schemaVersion", "imageSchemaMin", "imageSchemaMax",
        "imageAccessControlContract", "releaseRecordSchemaVersion",
    }
    json_fields = {"secretVersionIds", "secretMaterialFingerprints", "trustedProxyAddresses"}
    for field, line in zip(fields, lines):
        prefix = field + "="
        if not line.startswith(prefix):
            fail("DEPLOY_V5_STATE_INVALID")
        item = line[len(prefix):]
        if field in integer_fields:
            if re.fullmatch(r"0|[1-9][0-9]*", item) is None:
                fail("DEPLOY_V5_STATE_INVALID")
            value[field] = int(item)
        elif field in json_fields:
            try:
                value[field] = json.loads(item)
            except ValueError:
                fail("DEPLOY_V5_STATE_INVALID")
            if canonical_json(value[field]) != item:
                fail("DEPLOY_V5_STATE_INVALID")
        else:
            value[field] = item
    if migrating:
        value.update({
            "protocolVersion": 6,
            "ifindDiagnosticMode": "disabled",
            "ifindRefreshTokenVersionId": "",
            "ifindSecretBundleId": "none",
            "ifindSecretMaterialFingerprint": "",
        })
    return validate_state(value)


def validate_request(value: Any) -> dict[str, Any]:
    value = require_exact_keys(value, {
        "imageDigest", "commit", "secretProviderMode", "secretVersionIds",
        "secretMaterialFingerprints", "accessControlMode", "ifindDiagnosticMode",
        "ifindRefreshTokenVersionId", "ifindSecretMaterialFingerprint",
    }, "DEPLOY_V5_INTENT_STATE_INVALID")
    if DIGEST_PATTERN.fullmatch(value["imageDigest"]) is None or COMMIT_PATTERN.fullmatch(value["commit"]) is None:
        fail("DEPLOY_V5_INTENT_STATE_INVALID")
    provider = value["secretProviderMode"]
    if provider not in {"disabled", "github-tmpfs-v1"}:
        fail("DEPLOY_V5_INTENT_STATE_INVALID")
    versions = validate_secret_versions(value["secretVersionIds"], provider)
    fingerprints = validate_fingerprints(value["secretMaterialFingerprints"], provider)
    access = value["accessControlMode"]
    if access not in {"disabled", "device-approval"} or (access == "device-approval" and provider != "github-tmpfs-v1"):
        fail("DEPLOY_V5_INTENT_STATE_INVALID")
    mode, version, fingerprint, _ = validate_ifind_config(
        value["ifindDiagnosticMode"], value["ifindRefreshTokenVersionId"],
        value["ifindSecretMaterialFingerprint"], None,
    )
    return {
        **value,
        "secretVersionIds": versions,
        "secretMaterialFingerprints": fingerprints,
        "ifindDiagnosticMode": mode,
        "ifindRefreshTokenVersionId": version,
        "ifindSecretMaterialFingerprint": fingerprint,
    }


def check_version_reuse(current: dict[str, Any], request: dict[str, Any]) -> None:
    if (
        current["secretProviderMode"] == "github-tmpfs-v1"
        and request["secretProviderMode"] == "github-tmpfs-v1"
    ):
        pairs = (
            ("adminPasswordVerifier", current["secretVersionIds"]["adminPasswordVerifier"], request["secretVersionIds"]["adminPasswordVerifier"]),
            ("deviceTokenHmac", current["secretVersionIds"]["deviceTokenHmac"]["active"], request["secretVersionIds"]["deviceTokenHmac"]["active"]),
        )
        for key, current_version, request_version in pairs:
            if current_version == request_version and current["secretMaterialFingerprints"][key] != request["secretMaterialFingerprints"][key]:
                fail("SECRET_VERSION_REUSE_CONFLICT")
    if (
        current["ifindDiagnosticMode"] == "diagnostic"
        and request["ifindDiagnosticMode"] == "diagnostic"
        and current["ifindRefreshTokenVersionId"] == request["ifindRefreshTokenVersionId"]
        and current["ifindSecretMaterialFingerprint"] != request["ifindSecretMaterialFingerprint"]
    ):
        fail("SECRET_VERSION_REUSE_CONFLICT")


def security_matches(current: dict[str, Any], request: dict[str, Any]) -> bool:
    return all(request[field] == current[field] for field in (
        "secretProviderMode", "secretVersionIds", "secretMaterialFingerprints",
        "accessControlMode", "ifindDiagnosticMode", "ifindRefreshTokenVersionId",
        "ifindSecretMaterialFingerprint",
    ))


def resolve_intent(value: Any) -> dict[str, Any]:
    value = require_exact_keys(value, {"intent", "request", "current", "previous"}, "DEPLOY_V5_INTENT_STATE_INVALID")
    intent = value["intent"]
    if intent not in {"FORWARD", "ROLLBACK", "RESTORE"}:
        fail("DEPLOY_V5_INTENT_INVALID")
    request = validate_request(value["request"])
    current = validate_state(value["current"])
    previous = validate_state(value["previous"]) if value["previous"] is not None else None
    check_version_reuse(current, request)
    if previous is not None:
        check_version_reuse(previous, request)
    if intent == "FORWARD":
        if current["accessControlMode"] == "device-approval" and request["accessControlMode"] == "disabled":
            fail("ACCESS_CONTROL_DOWNGRADE_FORBIDDEN")
        if current["secretProviderMode"] == "github-tmpfs-v1" and request["secretProviderMode"] == "disabled":
            fail("SECRET_PROVIDER_DOWNGRADE_FORBIDDEN")
        return {
            "intent": intent,
            "operations": ["resolve-image", "preflight", "backup", "compose", "health", "state"],
            "ifindDiagnosticMode": request["ifindDiagnosticMode"],
            "ifindRefreshTokenVersionId": request["ifindRefreshTokenVersionId"],
            "ifindSecretMaterialFingerprint": request["ifindSecretMaterialFingerprint"],
            "secretMaterialFingerprints": request["secretMaterialFingerprints"],
            "secretVersionIds": request["secretVersionIds"],
            "accessControlMode": request["accessControlMode"],
        }
    if intent == "ROLLBACK":
        if previous is None:
            fail("ROLLBACK_STATE_UNAVAILABLE")
        if not security_matches(current, request):
            fail("ROLLBACK_SECURITY_STATE_MISMATCH")
        if request["imageDigest"] != previous["imageDigest"] or request["commit"] != previous["commit"]:
            fail("ROLLBACK_STATE_MISMATCH")
        if not previous["imageSchemaMin"] <= current["schemaVersion"] <= previous["imageSchemaMax"]:
            fail("ROLLBACK_REQUIRES_DB_RESTORE")
        target = {
            **previous,
            "secretProviderMode": current["secretProviderMode"],
            "secretVersionIds": current["secretVersionIds"],
            "secretBundleId": current["secretBundleId"],
            "secretMaterialFingerprints": current["secretMaterialFingerprints"],
            "accessControlMode": current["accessControlMode"],
            "imageAccessControlContract": current["imageAccessControlContract"],
            "trustedProxyAddresses": current["trustedProxyAddresses"],
            "trustedProxyConfigChecksum": current["trustedProxyConfigChecksum"],
            "ifindDiagnosticMode": current["ifindDiagnosticMode"],
            "ifindRefreshTokenVersionId": current["ifindRefreshTokenVersionId"],
            "ifindSecretBundleId": current["ifindSecretBundleId"],
            "ifindSecretMaterialFingerprint": current["ifindSecretMaterialFingerprint"],
        }
        return {
            "intent": intent,
            "operations": ["preflight", "backup", "compose", "health", "state"],
            "target": validate_state(target),
        }
    if (
        request["imageDigest"] != current["imageDigest"]
        or request["commit"] != current["commit"]
        or not security_matches(current, request)
    ):
        fail("RESTORE_STATE_MISMATCH")
    return {
        "intent": intent,
        "operations": ["preflight", "compose", "health", "state"],
        "target": current,
    }


def read_json_input() -> Any:
    raw = sys.stdin.buffer.read(MAX_JSON_INPUT_BYTES + 1)
    if len(raw) > MAX_JSON_INPUT_BYTES or b"\r" in raw:
        fail("DEPLOY_V5_INPUT_INVALID")
    try:
        return json.loads(raw)
    except (UnicodeDecodeError, ValueError):
        fail("DEPLOY_V5_INPUT_INVALID")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        fail("DEPLOY_V5_USAGE")
    command = argv[1]
    if command == "validate-payload":
        sys.stdout.write(canonical_json(read_payload()) + "\n")
        return 0
    if command == "canonical-state":
        sys.stdout.write(state_to_text(read_json_input()))
        return 0
    if command == "parse-state":
        raw = sys.stdin.buffer.read(MAX_JSON_INPUT_BYTES + 1)
        if len(raw) > MAX_JSON_INPUT_BYTES:
            fail("DEPLOY_V5_STATE_INVALID")
        try:
            state = parse_state_text(raw.decode("ascii"))
        except UnicodeDecodeError:
            fail("DEPLOY_V5_STATE_INVALID")
        sys.stdout.write(canonical_json(state) + "\n")
        return 0
    if command == "resolve-intent":
        sys.stdout.write(canonical_json(resolve_intent(read_json_input())) + "\n")
        return 0
    fail("DEPLOY_V5_USAGE")


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv))
    except ContractError as error:
        sys.stderr.write(error.code + "\n")
        raise SystemExit(2)
    except Exception:
        sys.stderr.write("DEPLOY_V5_INTERNAL_ERROR\n")
        raise SystemExit(1)
