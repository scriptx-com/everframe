# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Run finite real fatal-process probes. Every output stays in a fresh evidence root."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import resource
import shutil
import signal
import subprocess
import tempfile
import uuid

# Stack canary written by EFCRProbeMemoryFault; neither its bytes nor their hex form may persist.
STACK_MARKER = bytes((0x5A + 37 * i) & 0xFF for i in range(16))
ARCH = platform.machine()
X86 = ARCH == 'x86_64'
# Terminating signals of each fault on this native host.
SIGNALS = {'swift': {signal.SIGILL if X86 else signal.SIGTRAP}, 'objc': {signal.SIGABRT},
           'memory': {signal.SIGBUS, signal.SIGSEGV}, 'signal': {signal.SIGABRT},
           'leaf': {signal.SIGBUS, signal.SIGSEGV}, 'overflow': {signal.SIGBUS, signal.SIGSEGV}}
# Recorded error of each fault: (type, section, field, value).
ERRORS = {'swift': ('mach', 'mach', 'exception_name', 'EXC_BAD_INSTRUCTION' if X86 else 'EXC_BREAKPOINT'),
          'objc': ('nsexception', 'nsexception', 'name', 'EFCRQualification'),
          'memory': ('mach', 'mach', 'exception_name', 'EXC_BAD_ACCESS'),
          'signal': ('signal', 'signal', 'name', 'SIGABRT'),
          'leaf': ('mach', 'mach', 'exception_name', 'EXC_BAD_ACCESS'),
          'overflow': ('mach', 'mach', 'exception_name', 'EXC_BAD_ACCESS')}
# Frame 1 of each native fault is its real caller. These faults happen after their call left
# the return address in lr (arm64) or on the stack (x86_64), so this holds on both.
CALLERS = {'swift': 'main', 'memory': 'main', 'leaf': 'EFCRProbeLeafFault'}


def require(condition, message):
    # Explicit failures still run under python -O, unlike assert statements.
    if not condition:
        raise RuntimeError(message)


def child_limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def check_frames(name, fault, crashed, arch):
    """Checks the crashed thread's frames; returns the checks this architecture cannot make."""
    frames = crashed['backtrace']['contents']
    symbols = [frame.get('symbol_name') for frame in frames]
    addresses = [frame['instruction_addr'] for frame in frames]
    if fault in CALLERS:
        require(len(symbols) > 1 and symbols[1] == CALLERS[fault] and all(a != b for a, b in zip(addresses, addresses[1:])),
                f'{name}: caller missing or frame duplicated: {symbols[:4]}')
    if fault != 'overflow':
        return []
    # The arm64 stack overflow faults on a function's first instruction, before its frame
    # record exists, so frame 1 must be the link register itself. x86_64 has no link
    # register: its overflow faults on the call pushing the return address.
    if arch != 'arm64':
        return ['overflow-link-register']
    lr = crashed.get('registers', {}).get('basic', {}).get('lr')
    require(len(addresses) > 1 and addresses[1] == lr,
            f'{name}: link-register caller {lr} missing: {addresses[:4]}')
    return []


def run_probes(binary, evidence):
    binary = Path(binary).resolve(strict=True)
    evidence = Path(evidence).resolve()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    results = []

    def directory(name):
        path = evidence / name
        path.mkdir(mode=0o700)
        return path

    def bounded(name, length):
        # An existing empty 0700 directory whose canonical path is exactly `length` bytes.
        path = directory(name)
        remaining = length - len(str(path))
        require(remaining >= 2, f'evidence root is too long for a {length}-byte run directory')
        while remaining:
            size = min(255, remaining - 1)
            size -= remaining - size - 1 == 1
            path = path / ('p' * size)
            path.mkdir(mode=0o700)
            remaining -= size + 1
        return path

    def run(name, mode, path, extra=None, fatal=False, count=0):
        command = [str(binary), mode, str(path)] + ([] if extra is None else [str(extra)])
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=25, preexec_fn=child_limits)
        (evidence / f'{name}.stdout').write_bytes(result.stdout)
        (evidence / f'{name}.stderr').write_bytes(result.stderr)
        reports = []
        if mode != "invalid" and Path(path).is_dir():
            for report in sorted((Path(path) / 'Reports').glob('*.json')):
                raw = report.read_bytes()
                parsed = json.loads(raw)
                require('everframe_context_id' not in parsed.get('user', {}), f'{name}: legacy caller unexpectedly gained context')
                reports.append({'path': str(report.relative_to(evidence)), 'sha256': hashlib.sha256(raw).hexdigest(),
                                'id': parsed['report']['id'], 'error': parsed.get('crash', {}).get('error')})
        signals = sorted(SIGNALS[extra]) if fatal else []
        row = {'name': name, 'command': command, 'exitCode': result.returncode, 'fatal': fatal,
               'expectedSignals': [s.name for s in signals], 'expectedReports': count, 'reports': reports}
        results.append(row)
        (evidence / 'processes.json').write_text(json.dumps(results, indent=2) + '\n')
        require(result.returncode in [-s for s in signals] if fatal else result.returncode == 0,
                f'{name}: exit {result.returncode}, expected {row["expectedSignals"] or 0}')
        require(len(reports) == count, f'{name}: {len(reports)} reports, expected {count}')
        if mode != 'invalid' and Path(path).is_dir():
            for persisted in Path(path).rglob('*'):
                if persisted.is_file():
                    data = persisted.read_bytes()
                    require(b'EFCR_USERINFO_SECRET_91a73f' not in data, f'userInfo leaked into {persisted}')
                    require(STACK_MARKER not in data and STACK_MARKER.hex().upper().encode() not in data,
                            f'raw stack memory leaked into {persisted}')
        if count:
            parsed = json.loads((evidence / reports[0]['path']).read_bytes())
            error = parsed['crash']['error']
            kind, section, field, value = ERRORS[extra]
            require(error.get('type') == kind and error.get(section, {}).get(field) == value,
                    f'{name}: recorded error {error}, expected {kind} {value}')
            require(extra != 'objc' or error.get('reason') == 'synthetic fatal exception', f'{name}: exception reason')
            crashed = [t for t in parsed['crash']['threads'] if t.get('crashed')]
            require(len(crashed) == 1 and crashed[0].get('backtrace', {}).get('contents'),
                    f'{name}: crashed-thread backtrace missing')
            skipped = check_frames(name, extra, crashed[0], ARCH)
            if skipped:
                row['skippedChecks'] = skipped
                (evidence / 'processes.json').write_text(json.dumps(results, indent=2) + '\n')
        return row

    run('missing', 'invalid', evidence / 'absent')
    run('relative', 'invalid', 'relative-directory')
    run('overlong-nonexistent', 'invalid', '/' + 'x' * 1100)
    # The System monitor's 512-byte sidecar path allows run directories of at most 449 bytes.
    run('oversized', 'invalid', bounded('oversized', 450))
    permissive = directory('permissive'); permissive.chmod(0o755)
    run('permissive', 'invalid', permissive)
    nonempty = directory('nonempty'); (nonempty / 'sentinel').write_text('preserve')
    run('nonempty', 'invalid', nonempty)
    target = directory('symlink-target'); link = evidence / 'symlink'; link.symlink_to(target)
    run('symlink', 'invalid', link)
    canonical = directory('canonical')
    run('noncanonical', 'invalid', str(canonical) + '/.')
    file = evidence / 'file'; file.write_text('preserve')
    run('regular-file', 'invalid', file)
    second = directory('replacement')
    run('state', 'state', directory('state'), second)
    require(not list(second.iterdir()), 'second installation touched replacement directory')
    at_bound = bounded('at-bound', 449)
    run('at-bound', 'state', at_bound, directory('at-bound-replacement'))
    require(list(at_bound.glob('RunSidecars/*/System.ksscr')), 'System sidecar missing at the path bound')
    # Foundation reports /var and /tmp locations without the /private prefix realpath(3) adds.
    alias_root = Path(tempfile.mkdtemp(prefix='efcr-alias-', dir='/tmp')).resolve()
    require(str(alias_root).startswith('/private/'), f'{alias_root} has no /private alias')
    run('private-alias', 'state', str(alias_root)[len('/private'):], directory('private-alias-replacement'))
    require(list(alias_root.glob('RunSidecars/*/System.ksscr')), 'alias install did not use the canonical directory')
    shutil.move(str(alias_root), str(evidence / 'private-alias'))
    run('background-install', 'background-install', directory('background-install'))
    run('terminal', 'terminal', directory('terminal'), directory('vendor-poison'))
    for fault in ['leaf', 'overflow']:
        run(f'enabled-{fault}', 'enabled', directory(f'enabled-{fault}'), fault, fatal=True, count=1)
    for mode in ['enabled', 'disabled', 'disabled-after', 'disabled-off-main', 'reenabled', 'gate-closed', 'monitors-off']:
        for fault in ['swift', 'objc', 'memory', 'signal']:
            name = f'{mode}-{fault}'
            run(name, mode, directory(name), fault, fatal=True, count=int(mode in ['enabled', 'reenabled']))
    rapid = [run(f'rapid-{i}', 'enabled', directory(str(uuid.uuid4())), 'swift', fatal=True, count=1) for i in range(3)]
    require(len({row['reports'][0]['id'] for row in rapid}) == 3, 'rapid crash UUID collision')
    proof = {'schemaVersion': 1, 'arch': ARCH, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
             'processes': results}
    (evidence / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(f'{len(results)} fresh process probes passed: {evidence / "proof.json"}')
    return proof


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    run_probes(args.binary, args.evidence)
