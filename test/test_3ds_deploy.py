import ftplib
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "deploy_3ds", Path(__file__).resolve().parents[1] / "scripts/deploy-3ds.py"
)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class Ftp:
    def __init__(self, existing=True, fail_install=False, corrupt_readback=False):
        self.files = {"app.upload": b"new"}
        if existing:
            self.files["app"] = b"old"
        self.fail_install = fail_install
        self.corrupt_readback = corrupt_readback

    def rename(self, source, target):
        if target in self.files or (source == "app.upload" and self.fail_install):
            raise ftplib.error_perm("550 No such file or directory")
        self.files[target] = self.files.pop(source)

    def retrbinary(self, command, callback, blocksize):
        path = command.removeprefix("RETR ")
        callback(b"corrupt" if self.corrupt_readback else self.files[path])

    def delete(self, path):
        del self.files[path]


class PublishTests(unittest.TestCase):
    def publish(self, ftp, existing=True):
        deploy.publish_file(
            ftp, "app.upload", "app", hashlib.sha256(b"new").hexdigest(),
            hashlib.sha256(b"old").hexdigest() if existing else None,
        )

    def test_first_install(self):
        ftp = Ftp(existing=False)
        self.publish(ftp, existing=False)
        self.assertEqual(ftp.files, {"app": b"new"})

    def test_replace_without_rename_overwrite_support(self):
        ftp = Ftp()
        self.publish(ftp)
        self.assertEqual(ftp.files, {"app": b"new"})

    def test_failed_install_restores_original(self):
        ftp = Ftp(fail_install=True)
        with self.assertRaises(ftplib.error_perm):
            self.publish(ftp)
        self.assertEqual(ftp.files, {"app": b"old", "app.upload": b"new"})

    def test_failed_readback_restores_original(self):
        ftp = Ftp(corrupt_readback=True)
        with self.assertRaisesRegex(RuntimeError, "readback mismatch"):
            self.publish(ftp)
        self.assertEqual(ftp.files, {"app": b"old"})


if __name__ == "__main__":
    unittest.main()
