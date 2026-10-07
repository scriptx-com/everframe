# SPDX-License-Identifier: MIT
# SPDX-FileCopyrightText: 2026 ScriptX
"""Fresh fatal context probes; ctx-admitted explicitly simulates prior gate admission."""
import argparse
import hashlib
import json
from pathlib import Path
import resource
import subprocess


def child_limits(): resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def require(condition, message):
    # Explicit failures still run under python -O, unlike assert statements.
    if not condition: raise RuntimeError(message)


def run(binary, evidence):
    binary=Path(binary).resolve(strict=True); evidence=Path(evidence).resolve()
    evidence.mkdir(mode=0o700,parents=True,exist_ok=False)
    expected={'ctx-invalid':'11111111-1111-4111-8111-111111111111',
              'ctx-current':'11111111-1111-4111-8111-111111111111',
              'ctx-switched':'22222222-2222-4222-8222-222222222222',
              'ctx-admitted':'11111111-1111-4111-8111-111111111111',
              'ctx-cleared':None,'ctx-admitted-empty':None,
              'ctx-capacity':'11111111-1111-4111-8111-111111111111',
              'ctx-capacity-last':'00000000-0000-0000-0000-0000000000fe'}
    rows=[]
    for mode,identifier in expected.items():
        directory=evidence/mode;directory.mkdir(mode=0o700)
        command=[str(binary),mode,str(directory)]
        try:
            process=subprocess.run(command,capture_output=True,timeout=25,preexec_fn=child_limits)
        except subprocess.TimeoutExpired as error:
            (evidence/f'{mode}.stdout').write_bytes(error.stdout or b'')
            (evidence/f'{mode}.stderr').write_bytes(error.stderr or b'')
            (evidence/f'{mode}.timeout.json').write_text(json.dumps({'command':command,'timeout':25})+'\n')
            raise
        (evidence/f'{mode}.stdout').write_bytes(process.stdout);(evidence/f'{mode}.stderr').write_bytes(process.stderr)
        reports=list((directory/'Reports').glob('*.json'))
        row={'mode':mode,'command':command,'exitCode':process.returncode,'reports':len(reports),'expectedContext':identifier,
             'syntheticPriorAdmission':mode in ['ctx-admitted','ctx-admitted-empty']}
        rows.append(row);(evidence/'processes.json').write_text(json.dumps(rows,indent=2)+'\n')
        require(process.returncode==-5 and len(reports)==1,f'{mode}: exit {process.returncode} with {len(reports)} reports, expected -5 with 1')
        raw=reports[0].read_bytes();report=json.loads(raw)
        context=report.get('user',{}).get('everframe_context_id')
        require(context==identifier,f'{mode}: context {context}, expected {identifier}')
        row.update(reportPath=str(reports[0].relative_to(evidence)),reportSha256=hashlib.sha256(raw).hexdigest(),reportID=report['report']['id'])
    proof={'schemaVersion':1,'binarySha256':hashlib.sha256(binary.read_bytes()).hexdigest(),'processes':rows}
    (evidence/'proof.json').write_text(json.dumps(proof,indent=2)+'\n')
    print(f'{len(rows)} real fatal context probes passed; admitted-A row uses explicit synthetic prior admission')
    return proof


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--binary',required=True);parser.add_argument('--evidence',required=True)
    args=parser.parse_args();run(args.binary,args.evidence)
