#!/usr/bin/env python3
import hashlib
import gzip
import importlib.util
import inspect
import io
import json
import os
from pathlib import Path
import subprocess
import stat
import sys
import tarfile
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "deploy/server/offline-image-attestation.py"
REPOSITORY = "ghcr.io/zwphhxx/kinvest"
SOURCE_ANNOTATION = "containerd.io/distribution.source.ghcr.io"
OCI_INDEX = "application/vnd.oci.image.index.v1+json"
OCI_MANIFEST = "application/vnd.oci.image.manifest.v1+json"
OCI_CONFIG = "application/vnd.oci.image.config.v1+json"
OCI_LAYER = "application/vnd.oci.image.layer.v1.tar"


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def digest_bytes(value):
    return hashlib.sha256(value).hexdigest()


def raw_tar_header(name, size, typeflag, *, base256=False):
    header = bytearray(512)
    encoded_name = name.encode("ascii")
    header[: len(encoded_name)] = encoded_name
    header[100:108] = b"0000600\0"
    header[108:116] = b"0000000\0"
    header[116:124] = b"0000000\0"
    if base256:
        encoded_size = size.to_bytes(11, "big")
        header[124:136] = b"\x80" + encoded_size
    else:
        header[124:136] = f"{size:011o}\0".encode("ascii")
    header[136:148] = b"00000000000\0"
    header[148:156] = b"        "
    header[156:157] = typeflag
    header[257:263] = b"ustar\0"
    header[263:265] = b"00"
    checksum = sum(header)
    header[148:156] = f"{checksum:06o}\0 ".encode("ascii")
    return bytes(header)


def descriptor(media_type, content, **extra):
    result = {
        "digest": f"sha256:{digest_bytes(content)}",
        "mediaType": media_type,
        "size": len(content),
    }
    result.update(extra)
    return result


def load_module():
    spec = importlib.util.spec_from_file_location("offline_image_attestation", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


class ArchiveFixture:
    def __init__(self, directory, case="valid"):
        self.directory = Path(directory)
        self.case = case
        self.archive = self.directory / f"{case}.tar"
        self.members = {}
        self.special_members = []
        self._build()

    def _add_blob(self, content):
        digest = digest_bytes(content)
        self.members[f"blobs/sha256/{digest}"] = content
        return digest

    def _build(self):
        layers = [b"deterministic-layer-one\n", b"deterministic-layer-two\n"]
        labels = {
            "io.kinvest.schema.max": "1",
            "io.kinvest.schema.min": "0",
            "io.kinvest.secret-bootstrap": "1",
        }
        config = {
            "architecture": "arm64" if self.case == "wrong_config_platform" else "amd64",
            "config": {"Labels": labels},
            "os": "linux",
            "rootfs": {
                "diff_ids": [f"sha256:{digest_bytes(layer)}" for layer in layers],
                "type": "layers",
            },
        }
        config_bytes = canonical_json(config)
        config_digest = self._add_blob(config_bytes)
        layer_digests = [self._add_blob(layer) for layer in layers]

        runtime_manifest = {
            "config": descriptor(OCI_CONFIG, config_bytes),
            "layers": [
                descriptor(OCI_LAYER, layer) for layer in layers
            ],
            "mediaType": OCI_MANIFEST,
            "schemaVersion": 2,
        }
        if self.case == "runtime_manifest_artifact_type":
            runtime_manifest["artifactType"] = "application/vnd.in-toto+json"
        if self.case == "runtime_manifest_subject":
            runtime_manifest["subject"] = dict(runtime_manifest["config"])
        runtime_bytes = canonical_json(runtime_manifest)
        runtime_digest = self._add_blob(runtime_bytes)
        runtime_descriptor = descriptor(
            OCI_MANIFEST,
            runtime_bytes,
            platform={"architecture": "amd64", "os": "linux"},
        )
        if self.case == "runtime_descriptor_artifact_type":
            runtime_descriptor["artifactType"] = "application/vnd.in-toto+json"
        if self.case == "runtime_descriptor_subject":
            runtime_descriptor["subject"] = dict(runtime_manifest["config"])

        manifests = [runtime_descriptor]
        if self.case == "duplicate_runtime":
            manifests.append(dict(runtime_descriptor))
        if self.case == "absent_runtime":
            manifests[0] = {
                **runtime_descriptor,
                "platform": {"architecture": "arm64", "os": "linux"},
            }
        if self.case == "descriptor_size_tampering":
            manifests[0] = {**runtime_descriptor, "size": runtime_descriptor["size"] + 1}
        if self.case == "descriptor_digest_tampering":
            tampered = runtime_bytes + b" "
            claimed_digest = digest_bytes(tampered)
            self.members[f"blobs/sha256/{claimed_digest}"] = runtime_bytes
            del self.members[f"blobs/sha256/{runtime_digest}"]
            manifests[0] = {
                **runtime_descriptor,
                "digest": f"sha256:{claimed_digest}",
            }

        source_index = {
            "manifests": manifests,
            "mediaType": OCI_INDEX,
            "schemaVersion": 2,
        }
        if self.case == "valid_index_subject":
            source_index["subject"] = dict(runtime_descriptor)
        if self.case == "missing_index_subject":
            missing_subject = b"missing index subject"
            source_index["subject"] = descriptor(OCI_CONFIG, missing_subject)
        if self.case == "tampered_index_subject":
            source_index["subject"] = {
                **descriptor(OCI_MANIFEST, runtime_bytes),
                "size": len(runtime_bytes) + 1,
            }
        source_bytes = canonical_json(source_index)
        source_digest = self._add_blob(source_bytes)
        self.source_ref = f"{REPOSITORY}@sha256:{source_digest}"
        annotation = "someone-else/kinvest" if self.case == "wrong_source_annotation" else "zwphhxx/kinvest"
        layout_index = {
            "manifests": [
                descriptor(
                    OCI_INDEX,
                    source_bytes,
                    annotations={SOURCE_ANNOTATION: annotation},
                )
            ],
            "mediaType": OCI_INDEX,
            "schemaVersion": 2,
        }

        docker_config = f"blobs/sha256/{config_digest}"
        docker_layers = [f"blobs/sha256/{value}" for value in layer_digests]
        if self.case == "docker_config_mismatch":
            docker_config = docker_layers[0]
        if self.case == "docker_layer_mismatch":
            docker_layers = list(reversed(docker_layers))

        docker_manifest = {
            "Config": docker_config,
            "Layers": docker_layers,
        }
        if self.case != "missing_repo_tags":
            docker_manifest["RepoTags"] = None
        self.members.update({
            "index.json": canonical_json(layout_index),
            "manifest.json": canonical_json([docker_manifest]),
            "oci-layout": canonical_json({"imageLayoutVersion": "1.0.0"}),
        })
        if self.case == "deep_json":
            self.members["oci-layout"] = b"[" * 1100 + b"0" + b"]" * 1100
        if self.case == "nonfinite_nan":
            self.members["oci-layout"] = b'{"imageLayoutVersion":NaN}'
        if self.case == "nonfinite_infinity":
            self.members["oci-layout"] = b'{"imageLayoutVersion":Infinity}'

        if self.case == "missing_blob":
            del self.members[f"blobs/sha256/{layer_digests[-1]}"]
        if self.case == "unreferenced_blob":
            self._add_blob(b"not reachable from the source descriptor\n")
        if self.case == "streaming_layer_tampering":
            layer_path = f"blobs/sha256/{layer_digests[-1]}"
            original_layer = self.members[layer_path]
            self.members[layer_path] = b"X" + original_layer[1:]
        if self.case == "traversal":
            self.special_members.append(("../outside", b"unsafe", tarfile.REGTYPE))
        if self.case == "symlink":
            self.special_members.append(("blobs/sha256/" + "f" * 64, b"", tarfile.SYMTYPE))
        if self.case == "duplicate_member":
            self.special_members.append(("index.json", self.members["index.json"], tarfile.REGTYPE))

        self._write_tar()
        self.archive_sha = digest_bytes(self.archive.read_bytes())
        self.runtime_image_id = f"sha256:{config_digest}"
        self.platform_manifest_digest = f"sha256:{runtime_digest}"

    def _write_tar(self):
        with tarfile.open(self.archive, "w", format=tarfile.USTAR_FORMAT) as archive:
            for directory in ("blobs", "blobs/sha256"):
                info = tarfile.TarInfo(directory)
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                info.mtime = 0
                archive.addfile(info)
            for name in sorted(self.members):
                content = self.members[name]
                info = tarfile.TarInfo(name)
                info.mode = 0o644
                info.mtime = 0
                info.size = len(content)
                archive.addfile(info, io.BytesIO(content))
            for name, content, member_type in self.special_members:
                info = tarfile.TarInfo(name)
                info.mode = 0o644
                info.mtime = 0
                info.type = member_type
                if member_type == tarfile.SYMTYPE:
                    info.linkname = "../../outside"
                    info.size = 0
                    archive.addfile(info)
                else:
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))


class FakeDocker:
    def __init__(
        self,
        inspected=None,
        load_returncode=0,
        inspect_returncode=0,
        stderr="",
        inspect_stdout=None,
    ):
        self.inspected = inspected
        self.load_returncode = load_returncode
        self.inspect_returncode = inspect_returncode
        self.stderr = stderr
        self.inspect_stdout = inspect_stdout
        self.calls = []
        self.loaded_archive_path = None
        self.loaded_bytes = None

    def __call__(self, arguments, timeout):
        self.calls.append((list(arguments), timeout))
        if arguments[:2] == ["docker", "load"]:
            self.loaded_archive_path = Path(arguments[3])
            self.loaded_bytes = self.loaded_archive_path.read_bytes()
            return subprocess.CompletedProcess(
                arguments,
                self.load_returncode,
                stdout="Loaded image\n" if self.load_returncode == 0 else "",
                stderr=self.stderr,
            )
        if arguments[:3] == ["docker", "image", "inspect"]:
            return subprocess.CompletedProcess(
                arguments,
                self.inspect_returncode,
                stdout=(
                    self.inspect_stdout
                    if self.inspect_stdout is not None
                    else json.dumps(self.inspected)
                ) if self.inspect_returncode == 0 else "",
                stderr=self.stderr,
            )
        raise AssertionError(f"unexpected Docker arguments: {arguments!r}")


class OfflineImageAttestationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module = load_module()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self, case="valid"):
        return ArchiveFixture(self.temp.name, case)

    def verified_fixture(self):
        fixture = self.fixture()
        verified = self.module.verify_archive(
            fixture.archive,
            fixture.archive_sha,
            fixture.source_ref,
        )
        return fixture, verified

    def docker_inspection(self, verified, **overrides):
        inspection = {
            "Architecture": "amd64",
            "Config": {
                "Labels": {
                    "io.kinvest.schema.max": str(verified.schema_max),
                    "io.kinvest.schema.min": str(verified.schema_min),
                    "io.kinvest.secret-bootstrap": verified.secret_bootstrap,
                }
            },
            "Id": verified.runtime_image_id,
            "Os": "linux",
        }
        inspection.update(overrides)
        return inspection

    def state_options(self):
        return {
            "owner_uid": os.geteuid(),
            "owner_gid": os.getegid(),
        }

    def import_fixture(self, docker=None, **overrides):
        fixture, verified = self.verified_fixture()
        docker = docker or FakeDocker(self.docker_inspection(verified))
        options = {
            "archive_path": fixture.archive,
            "archive_sha256": fixture.archive_sha,
            "source_reference": fixture.source_ref,
            "commit": "a" * 40,
            "verification_run_id": "31601622272",
            "state_dir": Path(self.temp.name) / "offline-images",
            "docker": docker,
            "now": lambda: "2026-08-12T12:34:56Z",
            **self.state_options(),
        }
        options.update(overrides)
        record = self.module.import_archive(**options)
        return fixture, verified, docker, record, options

    def assert_archive_error(self, callback, expected_code="OFFLINE_ARCHIVE_INVALID", forbidden=()):
        with self.assertRaises(self.module.ArchiveVerificationError) as raised:
            callback()
        error = raised.exception
        self.assertEqual(error.code, expected_code)
        self.assertEqual(str(error), expected_code)
        self.assertEqual(error.args, (expected_code,))
        for value in forbidden:
            self.assertNotIn(value, str(error))
        return error

    def assert_rejected(self, case, archive_sha=None, expected_code="OFFLINE_ARCHIVE_INVALID"):
        fixture = self.fixture(case)
        self.assert_archive_error(
            lambda: self.module.verify_archive(
                fixture.archive,
                archive_sha or fixture.archive_sha,
                fixture.source_ref,
            ),
            expected_code,
            forbidden=(str(fixture.archive), fixture.source_ref),
        )

    def test_valid_archive_returns_immutable_runtime_identity(self):
        fixture = self.fixture()
        result = self.module.verify_archive(
            fixture.archive,
            fixture.archive_sha,
            fixture.source_ref,
        )
        self.assertEqual(result.source_reference, fixture.source_ref)
        self.assertEqual(result.platform, "linux/amd64")
        self.assertEqual(result.platform_manifest_digest, fixture.platform_manifest_digest)
        self.assertEqual(result.runtime_image_id, fixture.runtime_image_id)
        self.assertEqual(result.archive_sha256, fixture.archive_sha)
        self.assertEqual(result.schema_min, 0)
        self.assertEqual(result.schema_max, 1)
        self.assertEqual(result.secret_bootstrap, "1")

    def test_rejects_archive_checksum_mismatch(self):
        self.assert_rejected(
            "valid",
            archive_sha="0" * 64,
            expected_code="OFFLINE_ARCHIVE_CHECKSUM_MISMATCH",
        )

    def test_rejects_traversal_member(self):
        self.assert_rejected("traversal")

    def test_rejects_symlink_member(self):
        self.assert_rejected("symlink")

    def test_raw_preflight_rejects_huge_pax_before_tarfile(self):
        archive = Path(self.temp.name) / "huge-pax.tar"
        archive.write_bytes(
            raw_tar_header("pax", self.module.MAX_ARCHIVE_BYTES + 1, b"x")
            + b"\0" * 1024
        )
        checksum = digest_bytes(archive.read_bytes())
        with mock.patch.object(
            self.module.tarfile,
            "open",
            side_effect=AssertionError("tarfile must not process PAX headers"),
        ), self.assertRaises(self.module.ArchiveVerificationError) as raised:
            self.module.verify_archive(
                archive,
                checksum,
                f"{REPOSITORY}@sha256:{'a' * 64}",
            )
        self.assertEqual(
            str(raised.exception),
            "OFFLINE_ARCHIVE_TAR_EXTENSION_UNSUPPORTED",
        )

    def test_raw_preflight_rejects_huge_solaris_pax_before_tarfile(self):
        archive_bytes = raw_tar_header(
            "solaris-pax",
            self.module.MAX_ARCHIVE_BYTES + 1,
            b"X",
        )
        with tempfile.TemporaryDirectory() as temporary_directory:
            archive_path = Path(temporary_directory) / "huge-solaris-pax.tar"
            archive_path.write_bytes(archive_bytes)
            archive_sha256 = hashlib.sha256(archive_bytes).hexdigest()
            with mock.patch.object(
                self.module.tarfile,
                "open",
                side_effect=AssertionError("tarfile must not process Solaris PAX headers"),
            ) as tarfile_open:
                with self.assertRaises(Exception) as raised:
                    self.module._verify_archive(
                        archive_path,
                        archive_sha256,
                        "ghcr.io/zwphhxx/kinvest@sha256:" + "1" * 64,
                    )
            self.assertEqual(
                str(raised.exception),
                "OFFLINE_ARCHIVE_TAR_EXTENSION_UNSUPPORTED",
            )
            tarfile_open.assert_not_called()

    def test_gzip_preflight_rejects_huge_gnu_longname_before_tarfile(self):
        archive = Path(self.temp.name) / "huge-longname.tar.gz"
        payload = (
            raw_tar_header(
                "gnu-longname",
                self.module.MAX_ARCHIVE_BYTES + 1,
                b"L",
                base256=True,
            )
            + b"\0" * 1024
        )
        archive.write_bytes(gzip.compress(payload, mtime=0))
        checksum = digest_bytes(archive.read_bytes())
        with mock.patch.object(
            self.module.tarfile,
            "open",
            side_effect=AssertionError("tarfile must not process GNU headers"),
        ), self.assertRaises(self.module.ArchiveVerificationError) as raised:
            self.module.verify_archive(
                archive,
                checksum,
                f"{REPOSITORY}@sha256:{'b' * 64}",
            )
        self.assertEqual(
            str(raised.exception),
            "OFFLINE_ARCHIVE_TAR_EXTENSION_UNSUPPORTED",
        )

    def test_raw_tar_size_parser_accepts_positive_base256_and_rejects_negative(self):
        positive = b"\x80" + (513).to_bytes(11, "big")
        self.assertEqual(self.module._parse_raw_tar_size(positive), 513)
        with self.assertRaises(self.module.ArchiveVerificationError) as raised:
            self.module._parse_raw_tar_size(b"\xff" + b"\0" * 11)
        self.assertEqual(str(raised.exception), "OFFLINE_ARCHIVE_TAR_SIZE_INVALID")

    def test_rejects_duplicate_member(self):
        self.assert_rejected("duplicate_member")

    def test_rejects_unreferenced_blob(self):
        self.assert_rejected("unreferenced_blob")

    def test_rejects_wrong_source_annotation(self):
        self.assert_rejected("wrong_source_annotation")

    def test_rejects_descriptor_digest_tampering(self):
        self.assert_rejected("descriptor_digest_tampering")

    def test_rejects_descriptor_size_tampering(self):
        self.assert_rejected("descriptor_size_tampering")

    def test_rejects_missing_blob(self):
        self.assert_rejected("missing_blob")

    def test_rejects_duplicate_runtime_linux_amd64(self):
        self.assert_rejected("duplicate_runtime")

    def test_rejects_absent_runtime_linux_amd64(self):
        self.assert_rejected("absent_runtime")

    def test_rejects_docker_config_mismatch(self):
        self.assert_rejected("docker_config_mismatch")

    def test_rejects_docker_layer_order_mismatch(self):
        self.assert_rejected("docker_layer_mismatch")

    def test_rejects_wrong_config_platform(self):
        self.assert_rejected("wrong_config_platform")

    def test_validates_reachable_oci_index_subject(self):
        fixture = self.fixture("valid_index_subject")
        result = self.module.verify_archive(
            fixture.archive,
            fixture.archive_sha,
            fixture.source_ref,
        )
        self.assertEqual(result.runtime_image_id, fixture.runtime_image_id)

    def test_rejects_missing_oci_index_subject_blob(self):
        self.assert_rejected("missing_index_subject")

    def test_rejects_tampered_oci_index_subject_descriptor(self):
        self.assert_rejected("tampered_index_subject")

    def test_rejects_runtime_descriptor_artifact_type(self):
        self.assert_rejected("runtime_descriptor_artifact_type")

    def test_rejects_runtime_descriptor_subject(self):
        self.assert_rejected("runtime_descriptor_subject")

    def test_rejects_in_toto_runtime_manifest_artifact_type(self):
        self.assert_rejected("runtime_manifest_artifact_type")

    def test_rejects_runtime_manifest_subject(self):
        self.assert_rejected("runtime_manifest_subject")

    def test_archive_path_swap_cannot_change_verified_bytes(self):
        fixture = self.fixture("valid")
        replacement = ArchiveFixture(self.temp.name, "traversal")
        real_tar_open = tarfile.open
        swapped = False

        def swap_path_before_tar_parse(name=None, mode="r", fileobj=None, **kwargs):
            nonlocal swapped
            if not swapped:
                os.replace(replacement.archive, fixture.archive)
                swapped = True
            return real_tar_open(name=name, mode=mode, fileobj=fileobj, **kwargs)

        with mock.patch.object(
            self.module.tarfile,
            "open",
            side_effect=swap_path_before_tar_parse,
        ):
            result = self.module.verify_archive(
                fixture.archive,
                fixture.archive_sha,
                fixture.source_ref,
            )
        self.assertTrue(swapped)
        self.assertEqual(result.runtime_image_id, fixture.runtime_image_id)

    def test_rejects_manifest_without_repo_tags_key(self):
        self.assert_rejected("missing_repo_tags")

    def test_public_api_names_full_source_reference(self):
        parameters = inspect.signature(self.module.verify_archive).parameters
        self.assertIn("source_reference", parameters)
        self.assertNotIn("source_digest", parameters)
        fixture = self.fixture()
        result = self.module.verify_archive(
            archive=fixture.archive,
            archive_sha256=fixture.archive_sha,
            source_reference=fixture.source_ref,
        )
        self.assertEqual(result.source_reference, fixture.source_ref)
        self.assertFalse(hasattr(result, "source_digest"))

    def test_rejects_aggregate_captured_metadata_limit(self):
        fixture = self.fixture()
        with mock.patch.object(self.module, "MAX_CAPTURED_METADATA_BYTES", 1):
            self.assert_archive_error(
                lambda: self.module.verify_archive(
                    fixture.archive,
                    fixture.archive_sha,
                    fixture.source_ref,
                ),
                "OFFLINE_ARCHIVE_METADATA_LIMIT",
            )

    def test_rejects_cumulative_metadata_above_aggregate_limit(self):
        fixture = self.fixture()
        captured_metadata = [
            content
            for content in fixture.members.values()
            if content.lstrip(b" \t\r\n").startswith((b"{", b"["))
        ]
        self.assertGreater(len(captured_metadata), 1)
        aggregate_limit = max(len(content) for content in captured_metadata) + 1
        self.assertTrue(
            all(len(content) < aggregate_limit for content in captured_metadata)
        )
        self.assertGreater(sum(len(content) for content in captured_metadata), aggregate_limit)
        with mock.patch.object(
            self.module,
            "MAX_CAPTURED_METADATA_BYTES",
            aggregate_limit,
        ):
            self.assert_archive_error(
                lambda: self.module.verify_archive(
                    fixture.archive,
                    fixture.archive_sha,
                    fixture.source_ref,
                ),
                "OFFLINE_ARCHIVE_METADATA_LIMIT",
            )

    def test_rejects_tampered_streamed_non_json_layer(self):
        fixture = self.fixture("streaming_layer_tampering")
        tampered_layers = [
            content
            for name, content in fixture.members.items()
            if name.startswith("blobs/sha256/")
            and not content.lstrip(b" \t\r\n").startswith((b"{", b"["))
        ]
        self.assertGreater(len(tampered_layers), 0)
        self.assert_rejected("streaming_layer_tampering")

    def test_rejects_deep_json_with_stable_error(self):
        original_recursion_limit = sys.getrecursionlimit()
        try:
            for recursion_limit in (700, 5000):
                with self.subTest(recursion_limit=recursion_limit):
                    sys.setrecursionlimit(recursion_limit)
                    self.assert_rejected(
                        "deep_json",
                        expected_code="OFFLINE_ARCHIVE_JSON_INVALID",
                    )
        finally:
            sys.setrecursionlimit(original_recursion_limit)

    def test_json_depth_scan_ignores_structural_characters_inside_strings(self):
        deeply_looking_string = '[{"quoted":"\\\\\\\"","array":[]}]' * 2000
        payload = {"value": deeply_looking_string}
        self.assertEqual(self.module._parse_json(canonical_json(payload)), payload)

    def test_json_depth_scan_defers_unclosed_input_to_json_parser(self):
        with mock.patch.object(
            self.module.json,
            "loads",
            wraps=self.module.json.loads,
        ) as json_loads:
            self.assert_archive_error(
                lambda: self.module._parse_json(b'{"value":[1,2}'),
                "OFFLINE_ARCHIVE_JSON_INVALID",
            )
        json_loads.assert_called_once()

    def test_rejects_nonfinite_json_constants(self):
        for case in ("nonfinite_nan", "nonfinite_infinity"):
            with self.subTest(case=case):
                self.assert_rejected(
                    case,
                    expected_code="OFFLINE_ARCHIVE_JSON_INVALID",
                )

    def test_public_api_normalizes_value_and_overflow_errors(self):
        fixture = self.fixture()
        for exception_type in (ValueError, OverflowError):
            marker = f"private-{exception_type.__name__}-payload"
            with self.subTest(exception_type=exception_type.__name__), mock.patch.object(
                self.module,
                "_read_archive",
                side_effect=exception_type(marker),
            ):
                self.assert_archive_error(
                    lambda: self.module.verify_archive(
                        fixture.archive,
                        fixture.archive_sha,
                        fixture.source_ref,
                    ),
                    "OFFLINE_ARCHIVE_INVALID",
                    forbidden=(marker,),
                )

    def test_archive_descriptor_closes_on_success_and_rejection(self):
        real_open = os.open
        for checksum in (None, "0" * 64):
            fixture = self.fixture()
            opened = []

            def tracking_open(*args, **kwargs):
                descriptor = real_open(*args, **kwargs)
                opened.append(descriptor)
                return descriptor

            with self.subTest(checksum=checksum), mock.patch.object(
                self.module.os,
                "open",
                side_effect=tracking_open,
            ):
                if checksum is None:
                    self.module.verify_archive(
                        fixture.archive,
                        fixture.archive_sha,
                        fixture.source_ref,
                    )
                else:
                    self.assert_archive_error(
                        lambda: self.module.verify_archive(
                            fixture.archive,
                            checksum,
                            fixture.source_ref,
                        ),
                        "OFFLINE_ARCHIVE_CHECKSUM_MISMATCH",
                    )
            self.assertEqual(len(opened), 1)
            with self.assertRaises(OSError):
                os.fstat(opened[0])

    def test_raw_descriptor_closes_when_fdopen_fails(self):
        fixture = self.fixture()
        real_open = os.open
        opened = []
        marker = "private-fdopen-payload"

        def tracking_open(*args, **kwargs):
            descriptor = real_open(*args, **kwargs)
            opened.append(descriptor)
            return descriptor

        with mock.patch.object(
            self.module.os,
            "open",
            side_effect=tracking_open,
        ), mock.patch.object(
            self.module.os,
            "fdopen",
            side_effect=OSError(marker),
        ):
            self.assert_archive_error(
                lambda: self.module.verify_archive(
                    fixture.archive,
                    fixture.archive_sha,
                    fixture.source_ref,
                ),
                "OFFLINE_ARCHIVE_UNREADABLE",
                forbidden=(marker,),
            )
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError):
            os.fstat(opened[0])

    def test_import_loads_by_argument_array_and_writes_canonical_record(self):
        fixture, verified, docker, record, options = self.import_fixture()
        expected_path = options["state_dir"] / (
            verified.source_reference.rsplit(":", 1)[1] + ".state"
        )
        self.assertEqual(record.runtime_image_id, verified.runtime_image_id)
        self.assertEqual(docker.calls[0][0][:3], ["docker", "load", "--input"])
        self.assertNotEqual(docker.calls[0][0][3], str(fixture.archive))
        self.assertEqual(docker.calls[0][1], 120)
        self.assertFalse(Path(docker.calls[0][0][3]).exists())
        self.assertEqual(
            docker.calls[1],
            (
                [
                    "docker",
                    "image",
                    "inspect",
                    verified.runtime_image_id,
                    "--format",
                    "{{json .}}",
                ],
                10,
            ),
        )
        self.assertEqual(stat.S_IMODE(options["state_dir"].stat().st_mode), 0o700)
        self.assertEqual(stat.S_IMODE(expected_path.stat().st_mode), 0o600)
        self.assertEqual(
            expected_path.read_text(encoding="utf-8"),
            "\n".join(
                [
                    "version=1",
                    f"sourceDigest={verified.source_reference}",
                    "platform=linux/amd64",
                    f"platformManifestDigest={verified.platform_manifest_digest}",
                    f"runtimeImageId={verified.runtime_image_id}",
                    f"archiveSha256={verified.archive_sha256}",
                    f"commit={'a' * 40}",
                    "verificationRunId=31601622272",
                    "importedAt=2026-08-12T12:34:56Z",
                    "",
                ]
            ),
        )

    def test_import_failure_never_writes_record_or_replays_docker_stderr(self):
        fixture, verified = self.verified_fixture()
        state_dir = Path(self.temp.name) / "offline-images"
        for docker in (
            FakeDocker(
                self.docker_inspection(verified),
                load_returncode=1,
                stderr="private registry diagnostic",
            ),
            FakeDocker(
                self.docker_inspection(verified, Id="sha256:" + "f" * 64),
                stderr="private inspect diagnostic",
            ),
        ):
            with self.subTest(load_returncode=docker.load_returncode), self.assertRaises(
                self.module.OfflineAttestationError
            ) as raised:
                self.module.import_archive(
                    fixture.archive,
                    archive_sha256=fixture.archive_sha,
                    source_reference=fixture.source_ref,
                    commit="a" * 40,
                    verification_run_id="31601622272",
                    state_dir=state_dir,
                    docker=docker,
                    now=lambda: "2026-08-12T12:34:56Z",
                    **self.state_options(),
                )
            self.assertRegex(str(raised.exception), r"^OFFLINE_ATTESTATION_[A-Z_]+$")
            self.assertNotIn("private", str(raised.exception))
            self.assertEqual(list(state_dir.glob("*.state")), [])

    def test_store_rejects_insecure_directory_symlink_mode_and_owner(self):
        target = Path(self.temp.name) / "target"
        target.mkdir(mode=0o700)
        symlink = Path(self.temp.name) / "linked-state"
        symlink.symlink_to(target, target_is_directory=True)
        with self.assertRaises(self.module.OfflineAttestationError) as linked:
            self.module.AttestationStore(symlink, **self.state_options())
        self.assertEqual(str(linked.exception), "OFFLINE_ATTESTATION_STATE_UNSAFE")

        insecure = Path(self.temp.name) / "insecure-state"
        insecure.mkdir(mode=0o755)
        insecure.chmod(0o755)
        with self.assertRaises(self.module.OfflineAttestationError):
            self.module.AttestationStore(insecure, **self.state_options())

        secure = Path(self.temp.name) / "secure-state"
        secure.mkdir(mode=0o700)
        with self.assertRaises(self.module.OfflineAttestationError):
            self.module.AttestationStore(
                secure,
                owner_uid=os.geteuid() + 1,
                owner_gid=os.getegid(),
            )

    def test_store_rejects_record_symlink_wrong_mode_and_noncanonical_order(self):
        _, verified, _, _, options = self.import_fixture()
        record_path = next(options["state_dir"].glob("*.state"))
        canonical = record_path.read_text(encoding="utf-8")
        store = self.module.AttestationStore(options["state_dir"], **self.state_options())

        record_path.chmod(0o644)
        with self.assertRaises(self.module.OfflineAttestationError):
            store.read(verified.source_reference)
        record_path.chmod(0o600)

        lines = canonical.splitlines()
        lines[1], lines[2] = lines[2], lines[1]
        record_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        record_path.chmod(0o600)
        with self.assertRaises(self.module.OfflineAttestationError):
            store.read(verified.source_reference)

        record_path.unlink()
        outside = Path(self.temp.name) / "outside.state"
        outside.write_text(canonical, encoding="utf-8")
        outside.chmod(0o600)
        record_path.symlink_to(outside)
        with self.assertRaises(self.module.OfflineAttestationError):
            store.read(verified.source_reference)

    def test_identical_import_is_idempotent_but_conflicting_metadata_is_rejected(self):
        fixture, verified, docker, first, options = self.import_fixture()
        record_path = next(options["state_dir"].glob("*.state"))
        original = record_path.read_bytes()
        original_mtime = record_path.stat().st_mtime_ns
        second = self.module.import_archive(
            fixture.archive,
            archive_sha256=fixture.archive_sha,
            source_reference=fixture.source_ref,
            commit="a" * 40,
            verification_run_id="31601622272",
            state_dir=options["state_dir"],
            docker=docker,
            now=lambda: "2030-01-01T00:00:00Z",
            **self.state_options(),
        )
        self.assertEqual(second, first)
        self.assertEqual(record_path.read_bytes(), original)
        self.assertEqual(record_path.stat().st_mtime_ns, original_mtime)

        with self.assertRaises(self.module.OfflineAttestationError) as conflict:
            self.module.import_archive(
                fixture.archive,
                archive_sha256=fixture.archive_sha,
                source_reference=fixture.source_ref,
                commit="b" * 40,
                verification_run_id="31601622272",
                state_dir=options["state_dir"],
                docker=docker,
                now=lambda: "2030-01-01T00:00:00Z",
                **self.state_options(),
            )
        self.assertEqual(str(conflict.exception), "OFFLINE_ATTESTATION_CONFLICT")
        self.assertEqual(record_path.read_bytes(), original)

    def test_resolve_requires_exact_commit_run_and_live_image(self):
        _, verified, docker, _, options = self.import_fixture()
        for commit, run_id in (("b" * 40, "31601622272"), ("a" * 40, "9")):
            before = len(docker.calls)
            with self.subTest(commit=commit, run_id=run_id), self.assertRaises(
                self.module.OfflineAttestationError
            ) as raised:
                self.module.resolve_attestation(
                    verified.source_reference,
                    commit,
                    run_id,
                    state_dir=options["state_dir"],
                    docker=docker,
                    **self.state_options(),
                )
            self.assertEqual(str(raised.exception), "OFFLINE_ATTESTATION_PROVENANCE_MISMATCH")
            self.assertEqual(len(docker.calls), before)

        stale = FakeDocker(inspect_returncode=1, stderr="private missing image")
        with self.assertRaises(self.module.OfflineAttestationError) as raised:
            self.module.resolve_attestation(
                verified.source_reference,
                "a" * 40,
                "31601622272",
                state_dir=options["state_dir"],
                docker=stale,
                **self.state_options(),
            )
        self.assertEqual(str(raised.exception), "OFFLINE_ATTESTATION_IMAGE_UNAVAILABLE")
        self.assertNotIn("private", str(raised.exception))

    def test_resolve_rejects_runtime_platform_label_or_id_mismatch(self):
        _, verified, _, _, options = self.import_fixture()
        cases = [
            self.docker_inspection(verified, Architecture="arm64"),
            self.docker_inspection(verified, Id="sha256:" + "e" * 64),
            self.docker_inspection(
                verified,
                Config={"Labels": {"io.kinvest.schema.min": "99"}},
            ),
        ]
        for inspection in cases:
            with self.subTest(inspection=inspection), self.assertRaises(
                self.module.OfflineAttestationError
            ) as raised:
                self.module.resolve_attestation(
                    verified.source_reference,
                    "a" * 40,
                    "31601622272",
                    state_dir=options["state_dir"],
                    docker=FakeDocker(inspection),
                    **self.state_options(),
                )
            self.assertEqual(str(raised.exception), "OFFLINE_ATTESTATION_IMAGE_MISMATCH")

    def test_atomic_record_write_failure_cleans_temporary_file(self):
        fixture, verified = self.verified_fixture()
        state_dir = Path(self.temp.name) / "offline-images"
        docker = FakeDocker(self.docker_inspection(verified))
        with mock.patch.object(
            self.module.os,
            "link",
            side_effect=OSError("private atomic failure"),
        ), self.assertRaises(self.module.OfflineAttestationError) as raised:
            self.module.import_archive(
                fixture.archive,
                archive_sha256=fixture.archive_sha,
                source_reference=fixture.source_ref,
                commit="a" * 40,
                verification_run_id="31601622272",
                state_dir=state_dir,
                docker=docker,
                now=lambda: "2026-08-12T12:34:56Z",
                **self.state_options(),
            )
        self.assertEqual(str(raised.exception), "OFFLINE_ATTESTATION_WRITE_FAILED")
        self.assertEqual(list(state_dir.iterdir()), [])

    def test_import_api_cannot_accept_unrelated_verified_metadata(self):
        parameters = inspect.signature(self.module.import_archive).parameters
        self.assertNotIn("verified", parameters)
        self.assertIn("archive_path", parameters)
        self.assertIn("archive_sha256", parameters)
        self.assertIn("source_reference", parameters)

    def test_verification_run_id_accepts_twenty_digit_boundary_and_round_trips(self):
        run_id = "9" * 20
        _, verified, _, record, options = self.import_fixture(
            verification_run_id=run_id,
        )
        self.assertEqual(record.verification_run_id, run_id)
        store = self.module.AttestationStore(options["state_dir"], **self.state_options())
        self.assertEqual(store.read(verified.source_reference), record)

    def test_verification_run_id_rejects_one_over_before_docker_or_state(self):
        fixture, verified = self.verified_fixture()
        docker = FakeDocker(self.docker_inspection(verified))
        state_dir = Path(self.temp.name) / "offline-images"
        with self.assertRaises(self.module.OfflineAttestationError) as raised:
            self.module.import_archive(
                fixture.archive,
                archive_sha256=fixture.archive_sha,
                source_reference=fixture.source_ref,
                commit="a" * 40,
                verification_run_id="9" * 21,
                state_dir=state_dir,
                docker=docker,
                **self.state_options(),
            )
        self.assertEqual(str(raised.exception), "OFFLINE_ATTESTATION_INVALID")
        self.assertEqual(docker.calls, [])
        self.assertFalse(state_dir.exists())

    def test_very_long_verification_run_id_writes_no_record(self):
        fixture, verified = self.verified_fixture()
        docker = FakeDocker(self.docker_inspection(verified))
        state_dir = Path(self.temp.name) / "offline-images"
        with self.assertRaises(self.module.OfflineAttestationError):
            self.module.import_archive(
                fixture.archive,
                archive_sha256=fixture.archive_sha,
                source_reference=fixture.source_ref,
                commit="a" * 40,
                verification_run_id="7" * 100_000,
                state_dir=state_dir,
                docker=docker,
                **self.state_options(),
            )
        self.assertEqual(docker.calls, [])
        self.assertFalse(state_dir.exists())

    def test_oversized_canonical_record_is_rejected_before_temp_file_creation(self):
        _, _, _, record, _ = self.import_fixture()
        state_dir = Path(self.temp.name) / "bounded-records"
        store = self.module.AttestationStore(state_dir, **self.state_options())
        with mock.patch.object(
            self.module,
            "MAX_RECORD_BYTES",
            1,
        ), mock.patch.object(
            self.module.tempfile,
            "mkstemp",
            side_effect=AssertionError("temporary file must not be created"),
        ), self.assertRaises(self.module.OfflineAttestationError) as raised:
            store.write(record)
        self.assertEqual(str(raised.exception), "OFFLINE_ATTESTATION_RECORD_TOO_LARGE")
        self.assertEqual(list(state_dir.iterdir()), [])

    def test_docker_inspect_invalid_json_maps_to_image_mismatch(self):
        _, verified, _, _, options = self.import_fixture()
        payloads = (
            '{"Id":"sha256:' + "a" * 64 + '","Id":"sha256:' + "b" * 64 + '"}',
            "{malformed",
            '{"Id":NaN}',
            '{"Id":Infinity}',
        )
        for payload in payloads:
            with self.subTest(payload=payload), self.assertRaises(
                self.module.OfflineAttestationError
            ) as raised:
                self.module.resolve_attestation(
                    verified.source_reference,
                    "a" * 40,
                    "31601622272",
                    state_dir=options["state_dir"],
                    docker=FakeDocker(inspect_stdout=payload),
                    **self.state_options(),
                )
            self.assertEqual(
                str(raised.exception),
                "OFFLINE_ATTESTATION_IMAGE_MISMATCH",
            )
            self.assertNotIsInstance(
                raised.exception,
                self.module.ArchiveVerificationError,
            )

    def test_source_replacement_after_verification_cannot_change_docker_bytes(self):
        fixture = self.fixture("valid")
        replacement = ArchiveFixture(self.temp.name, "traversal")
        verified_bytes = fixture.archive.read_bytes()
        verified = self.module.verify_archive(
            fixture.archive,
            fixture.archive_sha,
            fixture.source_ref,
        )
        docker = FakeDocker(self.docker_inspection(verified))
        state_dir = Path(self.temp.name) / "offline-images"
        real_copy = self.module._copy_verified_source_to_snapshot

        def replace_source_then_copy(source, destination):
            os.replace(replacement.archive, fixture.archive)
            return real_copy(source, destination)

        with mock.patch.object(
            self.module,
            "_copy_verified_source_to_snapshot",
            side_effect=replace_source_then_copy,
        ):
            record = self.module.import_archive(
                fixture.archive,
                archive_sha256=fixture.archive_sha,
                source_reference=fixture.source_ref,
                commit="a" * 40,
                verification_run_id="31601622272",
                state_dir=state_dir,
                docker=docker,
                now=lambda: "2026-08-12T12:34:56Z",
                **self.state_options(),
            )
        self.assertEqual(docker.loaded_bytes, verified_bytes)
        self.assertNotEqual(fixture.archive.read_bytes(), verified_bytes)
        self.assertEqual(record.archive_sha256, fixture.archive_sha)
        self.assertFalse(docker.loaded_archive_path.exists())
        self.assertFalse(docker.loaded_archive_path.parent.exists())

    def test_verification_failure_does_not_load_or_write_record(self):
        fixture = self.fixture()
        docker = FakeDocker()
        state_dir = Path(self.temp.name) / "offline-images"
        with self.assertRaises(self.module.ArchiveVerificationError) as raised:
            self.module.import_archive(
                fixture.archive,
                archive_sha256="0" * 64,
                source_reference=fixture.source_ref,
                commit="a" * 40,
                verification_run_id="31601622272",
                state_dir=state_dir,
                docker=docker,
                now=lambda: "2026-08-12T12:34:56Z",
                **self.state_options(),
            )
        self.assertEqual(str(raised.exception), "OFFLINE_ARCHIVE_CHECKSUM_MISMATCH")
        self.assertEqual(docker.calls, [])
        self.assertFalse(state_dir.exists())

    def test_private_snapshot_is_cleaned_after_docker_load_failure(self):
        fixture = self.fixture()
        docker = FakeDocker(load_returncode=1, stderr="private docker failure")
        state_dir = Path(self.temp.name) / "offline-images"
        with self.assertRaises(self.module.OfflineAttestationError):
            self.module.import_archive(
                fixture.archive,
                archive_sha256=fixture.archive_sha,
                source_reference=fixture.source_ref,
                commit="a" * 40,
                verification_run_id="31601622272",
                state_dir=state_dir,
                docker=docker,
                now=lambda: "2026-08-12T12:34:56Z",
                **self.state_options(),
            )
        self.assertIsNotNone(docker.loaded_archive_path)
        self.assertFalse(docker.loaded_archive_path.exists())
        self.assertFalse(docker.loaded_archive_path.parent.exists())
        self.assertFalse(state_dir.exists())

    def test_store_read_closes_raw_descriptor_when_fdopen_fails(self):
        _, verified, _, _, options = self.import_fixture()
        store = self.module.AttestationStore(options["state_dir"], **self.state_options())
        real_open = os.open
        opened = []

        def tracking_open(*arguments, **kwargs):
            descriptor = real_open(*arguments, **kwargs)
            opened.append(descriptor)
            return descriptor

        with mock.patch.object(
            self.module.os,
            "open",
            side_effect=tracking_open,
        ), mock.patch.object(
            self.module.os,
            "fdopen",
            side_effect=OSError("private fdopen failure"),
        ), self.assertRaises(self.module.OfflineAttestationError) as raised:
            store.read(verified.source_reference)
        self.assertEqual(str(raised.exception), "OFFLINE_ATTESTATION_RECORD_UNSAFE")
        self.assertNotIn("private", str(raised.exception))
        self.assertEqual(len(opened), 1)
        with self.assertRaises(OSError):
            os.fstat(opened[0])

    def test_cli_forms_root_gate_and_exact_output(self):
        fixture, verified = self.verified_fixture()
        state_dir = Path(self.temp.name) / "offline-images"
        docker = FakeDocker(self.docker_inspection(verified))

        output = io.StringIO()
        errors = io.StringIO()
        self.assertEqual(
            self.module.main(
                ["verify-archive", str(fixture.archive), fixture.archive_sha, fixture.source_ref],
                stdout=output,
                stderr=errors,
            ),
            0,
        )
        self.assertEqual(
            output.getvalue(),
            f"KINVEST_OFFLINE_ARCHIVE_OK runtimeImageId={verified.runtime_image_id}\n",
        )
        self.assertEqual(errors.getvalue(), "")

        for command in ("import", "resolve"):
            output = io.StringIO()
            errors = io.StringIO()
            arguments = (
                [command, str(fixture.archive), fixture.archive_sha, fixture.source_ref, "a" * 40, "31601622272"]
                if command == "import"
                else [command, fixture.source_ref, "a" * 40, "31601622272"]
            )
            self.assertEqual(
                self.module.main(
                    arguments,
                    stdout=output,
                    stderr=errors,
                    geteuid=lambda: 501,
                    state_dir=state_dir,
                    docker=docker,
                    **self.state_options(),
                ),
                1,
            )
            self.assertEqual(output.getvalue(), "")
            self.assertEqual(errors.getvalue(), "OFFLINE_ATTESTATION_ROOT_REQUIRED\n")

        output = io.StringIO()
        self.assertEqual(
            self.module.main(
                ["import", str(fixture.archive), fixture.archive_sha, fixture.source_ref, "a" * 40, "31601622272"],
                stdout=output,
                stderr=io.StringIO(),
                geteuid=lambda: 0,
                state_dir=state_dir,
                docker=docker,
                **self.state_options(),
            ),
            0,
        )
        self.assertEqual(
            output.getvalue(),
            f"KINVEST_OFFLINE_IMPORT_OK runtimeImageId={verified.runtime_image_id}\n",
        )

        output = io.StringIO()
        self.assertEqual(
            self.module.main(
                ["resolve", fixture.source_ref, "a" * 40, "31601622272"],
                stdout=output,
                stderr=io.StringIO(),
                geteuid=lambda: 0,
                state_dir=state_dir,
                docker=docker,
                **self.state_options(),
            ),
            0,
        )
        self.assertEqual(output.getvalue(), verified.runtime_image_id + "\n")

        output = io.StringIO()
        self.assertEqual(
            self.module.main(["self-check"], stdout=output, stderr=io.StringIO()),
            0,
        )
        self.assertEqual(output.getvalue(), "KINVEST_OFFLINE_ATTESTATION_SELF_CHECK_OK\n")


if __name__ == "__main__":
    unittest.main()
