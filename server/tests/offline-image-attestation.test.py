#!/usr/bin/env python3
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
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

        if self.case == "missing_blob":
            del self.members[f"blobs/sha256/{layer_digests[-1]}"]
        if self.case == "unreferenced_blob":
            self._add_blob(b"not reachable from the source descriptor\n")
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

    def assert_rejected(self, case, archive_sha=None):
        fixture = self.fixture(case)
        with self.assertRaises(self.module.ArchiveVerificationError):
            self.module.verify_archive(
                fixture.archive,
                archive_sha or fixture.archive_sha,
                fixture.source_ref,
            )

    def test_valid_archive_returns_immutable_runtime_identity(self):
        fixture = self.fixture()
        result = self.module.verify_archive(
            fixture.archive,
            fixture.archive_sha,
            fixture.source_ref,
        )
        self.assertEqual(result.source_digest, fixture.source_ref)
        self.assertEqual(result.platform, "linux/amd64")
        self.assertEqual(result.platform_manifest_digest, fixture.platform_manifest_digest)
        self.assertEqual(result.runtime_image_id, fixture.runtime_image_id)
        self.assertEqual(result.archive_sha256, fixture.archive_sha)
        self.assertEqual(result.schema_min, 0)
        self.assertEqual(result.schema_max, 1)
        self.assertEqual(result.secret_bootstrap, "1")

    def test_rejects_archive_checksum_mismatch(self):
        self.assert_rejected("valid", archive_sha="0" * 64)

    def test_rejects_traversal_member(self):
        self.assert_rejected("traversal")

    def test_rejects_symlink_member(self):
        self.assert_rejected("symlink")

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


if __name__ == "__main__":
    unittest.main()
