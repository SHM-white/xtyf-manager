"""Deterministic build version and Android upgrade order."""
import unittest
from clients.versioning_ci import version_code,parse_refs
class VersioningTests(unittest.TestCase):
    def test_android_order(self):
        self.assertEqual(version_code("1.2.0-beta.1"),102000001)
        self.assertEqual(version_code("1.2.0-beta.2"),102000002)
        self.assertEqual(version_code("1.2.0"),102009999)
        self.assertLess(version_code("1.2.0-beta.998"),version_code("1.2.0"))
        self.assertLess(version_code("1.2.0"),version_code("1.2.1-beta.1"))
        self.assertGreater(version_code("1.2.0-beta.1"),14)
    def test_invalid(self):
        for s in ("1.2.0-beta.0","1.2.0-beta.9999","1.2.0-rc.1","01.2.0","20.0.0","1.100.0","1.2.100"):
            with self.subTest(s=s),self.assertRaises(ValueError):version_code(s)
    def test_beta_refs(self):
        refs="a\trefs/tags/v1.2.0-beta.1\nb\trefs/tags/v1.2.0-beta.23\nc\trefs/tags/v1.2.0-beta.2^{}\nd\trefs/tags/v1.3.0-beta.100\n"
        self.assertEqual(parse_refs(refs,"1.2.0"),23)
        self.assertEqual(parse_refs(refs,"1.4.0"),0)
