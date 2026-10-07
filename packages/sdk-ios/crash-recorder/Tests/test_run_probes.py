# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Per-architecture frame checks of run-probes.py, exercised with synthetic crashed threads."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('run_probes', Path(__file__).with_name('run-probes.py'))
probes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probes)


def thread(frames, registers):
    contents = [{'symbol_name': symbol, 'instruction_addr': address} for symbol, address in frames]
    return {'crashed': True, 'registers': {'basic': registers}, 'backtrace': {'contents': contents}}


# arm64 stack overflow at RecurseB's first instruction: frame 0 is named after the preceding
# function, frame 1 is lr, and the frame after it is skipped as in upstream KSCrash.
ARM64_OVERFLOW = [('EFCRProbeRecurseA', 0x100831eb0), ('EFCRProbeRecurseA', 0x100831e98),
                  ('EFCRProbeRecurseA', 0x100831e98), ('EFCRProbeRecurseB', 0x100831ebc)]
# x86_64 writes rip/rsp/rbp and no link register; the overflow faults on the call that
# pushes the return address, so frame 1 comes from the frame record like any other frame.
X86_OVERFLOW = thread([('EFCRProbeRecurseA', 0x100003f84), ('EFCRProbeRecurseB', 0x100003f99),
                       ('EFCRProbeRecurseA', 0x100003f89), ('EFCRProbeRecurseB', 0x100003f99)],
                      {'rip': 0x100003f84, 'rsp': 0x7ff7b6f00008, 'rbp': 0x7ff7b6f00010})


class FrameChecks(unittest.TestCase):
    def test_x86_64_overflow_records_the_skipped_link_register_check(self):
        self.assertEqual(probes.check_frames('enabled-overflow', 'overflow', X86_OVERFLOW, 'x86_64'),
                         ['overflow-link-register'])

    def test_arm64_overflow_keeps_the_link_register_caller(self):
        kept = thread(ARM64_OVERFLOW, {'pc': 0x100831eb0, 'lr': 0x100831e98})
        self.assertEqual(probes.check_frames('enabled-overflow', 'overflow', kept, 'arm64'), [])

    def test_arm64_overflow_rejects_another_frame_1(self):
        moved = thread(ARM64_OVERFLOW, {'pc': 0x100831eb0, 'lr': 0x100831ebc})
        with self.assertRaisesRegex(RuntimeError, 'link-register caller'):
            probes.check_frames('enabled-overflow', 'overflow', moved, 'arm64')

    def test_arm64_overflow_without_link_register_fails(self):
        with self.assertRaisesRegex(RuntimeError, 'link-register caller None'):
            probes.check_frames('enabled-overflow', 'overflow', X86_OVERFLOW, 'arm64')

    def test_real_callers_are_required_on_every_architecture(self):
        leaf = [('EFCRProbeLeafStore', 0x100002e40), ('EFCRProbeLeafFault', 0x100002e84), ('main', 0x100002b90)]
        skipped = [('EFCRProbeLeafStore', 0x100002e40), ('main', 0x100002b90)]
        repeated = [('EFCRProbeLeafStore', 0x100002e40), ('EFCRProbeLeafFault', 0x100002e84),
                    ('EFCRProbeLeafFault', 0x100002e84)]
        for arch in ['arm64', 'x86_64']:
            with self.subTest(arch=arch):
                self.assertEqual(probes.check_frames('enabled-leaf', 'leaf', thread(leaf, {}), arch), [])
                for frames in [skipped, repeated]:
                    with self.assertRaisesRegex(RuntimeError, 'caller missing or frame duplicated'):
                        probes.check_frames('enabled-leaf', 'leaf', thread(frames, {}), arch)


if __name__ == '__main__':
    unittest.main()
