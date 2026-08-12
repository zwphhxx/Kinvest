#!/usr/bin/env python3
"""Validate non-secret Kinvest SSM VersionId deployment metadata."""

import json
import os
import re
import sys


VERSION_PATTERN = re.compile(r"^v[0-9]{8}-[0-9]{3}$")
ERROR_CODE = "SECRET_VERSION_CONFIG_INVALID"


class ConfigError(Exception):
    pass


def fail():
    raise ConfigError()


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail()
        result[key] = value
    return result


def read_single_line():
    source = sys.stdin.read()
    if source.endswith("\n"):
        source = source[:-1]
    if not source or "\n" in source or "\r" in source:
        fail()
    return source


def parse_json(source):
    try:
        return json.loads(source, object_pairs_hook=unique_object)
    except (ConfigError, json.JSONDecodeError, UnicodeError):
        fail()


def valid_version(value):
    return isinstance(value, str) and VERSION_PATTERN.fullmatch(value) is not None


def canonical_mapping(source):
    value = parse_json(source)
    if value == {}:
        canonical = "{}"
    else:
        if not isinstance(value, dict) or list(value.keys()) != [
            "adminPasswordVerifier",
            "deviceTokenHmac",
        ]:
            fail()
        admin = value["adminPasswordVerifier"]
        device = value["deviceTokenHmac"]
        if not valid_version(admin) or not isinstance(device, dict):
            fail()
        if list(device.keys()) != ["accepted", "active"]:
            fail()
        accepted = device["accepted"]
        active = device["active"]
        if (
            not isinstance(accepted, list)
            or not 1 <= len(accepted) <= 10
            or not all(valid_version(version) for version in accepted)
            or accepted != sorted(accepted)
            or len(set(accepted)) != len(accepted)
            or not valid_version(active)
            or active not in accepted
        ):
            fail()
        canonical = json.dumps(
            {
                "adminPasswordVerifier": admin,
                "deviceTokenHmac": {"accepted": accepted, "active": active},
            },
            separators=(",", ":"),
        )
    if source != canonical:
        fail()
    return canonical


def mapping_from_environment():
    enabled = os.environ.get("SSM_BOOTSTRAP_ENABLED", "")
    admin = os.environ.get("SSM_ADMIN_PASSWORD_VERIFIER_VERSION_ID", "")
    active = os.environ.get("SSM_DEVICE_TOKEN_HMAC_ACTIVE_VERSION_ID", "")
    accepted_source = os.environ.get("SSM_DEVICE_TOKEN_HMAC_ACCEPTED_VERSION_IDS", "")
    if enabled in ("", "false"):
        if admin or active or accepted_source:
            fail()
        return "{}"
    if enabled != "true" or not admin or not active or not accepted_source:
        fail()
    accepted = parse_json(accepted_source)
    if not isinstance(accepted, list):
        fail()
    candidate = json.dumps(
        {
            "adminPasswordVerifier": admin,
            "deviceTokenHmac": {"accepted": accepted, "active": active},
        },
        separators=(",", ":"),
    )
    return canonical_mapping(candidate)


def main():
    if len(sys.argv) != 2:
        fail()
    command = sys.argv[1]
    if command == "from-env":
        result = mapping_from_environment()
    elif command in ("mapping", "count"):
        result = canonical_mapping(read_single_line())
        if command == "count":
            parsed = parse_json(result)
            result = "0" if parsed == {} else str(1 + len(parsed["deviceTokenHmac"]["accepted"]))
    else:
        fail()
    sys.stdout.write(f"{result}\n")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.stderr.write(f"{ERROR_CODE}\n")
        raise SystemExit(2)
