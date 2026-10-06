# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Run finite real fatal-process probes. Every output stays in a fresh evidence root."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import subprocess
import uuid


def child_limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def run_probes(binary, evidence):
    binary = Path(binary).resolve(strict=True)
    evidence = Path(evidence).resolve()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    results = []

    def directory(name):
        path = evidence / name
        path.mkdir(mode=0o700)
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
                reports.append({'path': str(report.relative_to(evidence)), 'sha256': hashlib.sha256(raw).hexdigest(),
                                'id': parsed['report']['id'], 'error': parsed.get('crash', {}).get('error')})
        row = {'name': name, 'command': command, 'exitCode': result.returncode, 'fatal': fatal,
               'expectedReports': count, 'reports': reports}
        results.append(row)
        (evidence / 'processes.json').write_text(json.dumps(results, indent=2) + '\n')
        assert (result.returncode < 0 if fatal else result.returncode == 0), row
        assert len(reports) == count, row
        if mode != 'invalid' and Path(path).is_dir():
            for persisted in Path(path).rglob('*'):
                if persisted.is_file():
                    assert b'EFCR_USERINFO_SECRET_91a73f' not in persisted.read_bytes(), f'userInfo leaked into {persisted}'
        if extra == 'objc' and count:
            parsed = json.loads((evidence / reports[0]['path']).read_bytes())
            assert parsed['crash']['error']['nsexception']['name'] == 'EFCRQualification'
            assert parsed['crash']['error']['reason'] == 'synthetic fatal exception'
            assert any(t.get('crashed') and t.get('backtrace',{}).get('contents') for t in parsed['crash']['threads'])
        return row

    run('missing', 'invalid', evidence / 'absent')
    run('relative', 'invalid', 'relative-directory')
    run('oversized', 'invalid', '/' + 'x' * 1100)
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
    assert not list(second.iterdir()), 'second installation touched replacement directory'
    run('terminal', 'terminal', directory('terminal'), directory('vendor-poison'))
    for mode in ['enabled', 'disabled', 'disabled-after', 'reenabled']:
        for fault in ['swift', 'objc', 'memory']:
            name = f'{mode}-{fault}'
            run(name, mode, directory(name), fault, fatal=True, count=int(mode in ['enabled', 'reenabled']))
    rapid = [run(f'rapid-{i}', 'enabled', directory(str(uuid.uuid4())), 'swift', fatal=True, count=1) for i in range(3)]
    assert len({row['reports'][0]['id'] for row in rapid}) == 3, 'rapid crash UUID collision'
    proof = {'schemaVersion': 1, 'binarySha256': hashlib.sha256(binary.read_bytes()).hexdigest(), 'processes': results}
    (evidence / 'proof.json').write_text(json.dumps(proof, indent=2) + '\n')
    print(f'{len(results)} fresh process probes passed: {evidence / "proof.json"}')
    return proof


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--binary', required=True)
    parser.add_argument('--evidence', required=True)
    args = parser.parse_args()
    run_probes(args.binary, args.evidence)
