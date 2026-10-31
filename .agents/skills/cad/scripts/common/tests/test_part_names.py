import unittest

from common.part_names import own_label


class OwnLabelTests(unittest.TestCase):
    def test_a_chosen_name_is_kept_whatever_its_case(self) -> None:
        for name in ("shell", "Shell", "Solid", "lid", "face plate", "608 bearing"):
            with self.subTest(name=name):
                self.assertEqual(name, own_label(name))
        self.assertEqual("lid top", own_label("  lid \t top "))

    def test_a_made_up_or_missing_name_counts_as_no_label(self) -> None:
        for name in (None, "", "   ", "SOLID", "COMPOUND", "SHELL", "=>[0:1:1:3]", "12",
                     "Open CASCADE STEP translator 7.8 1", "Open_CASCADE_STEP_translator_7.8_1"):
            with self.subTest(name=name):
                self.assertIsNone(own_label(name))


if __name__ == "__main__":
    unittest.main()
