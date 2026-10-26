"""Source-policy regressions; these checks do not observe model behavior."""
from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[2] / 'skills/independent-audit-gate')
    args = parser.parse_args()
    root = args.root.resolve()
    spec = importlib.util.spec_from_file_location('audit_validator', root / 'scripts/validate_skill.py')
    validator = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(validator)
    errors: list[str] = []
    validator.validate_policy(root, errors)
    assert not errors, errors
    cases = json.loads(Path(__file__).with_name('behavior-cases.json').read_text(encoding='utf-8'))['cases']
    checked = 0
    for case in cases:
        if 'sourceRule' not in case:
            continue
        with tempfile.TemporaryDirectory(prefix='audit-policy-regression-') as directory:
            mutant = Path(directory) / 'skills/independent-audit-gate'
            shutil.copytree(root, mutant)
            (mutant.parent.parent / 'plugin.json').write_text('{"name":"audit-regression-fixture"}\n', encoding='utf-8')
            path = mutant / case['file']
            content = path.read_text(encoding='utf-8')
            assert case['required'] in content, case['id']
            path.write_text(content.replace(case['required'], case['regression']), encoding='utf-8', newline='\n')
            mutant_errors: list[str] = []
            validator.validate_policy(mutant, mutant_errors)
            assert any(case['sourceRule'] in error for error in mutant_errors), (case['id'], mutant_errors)
            # Exercise the shipped CLI, not just the helper or a source-text assertion.
            command = [sys.executable, str(root / 'scripts/validate_skill.py'), '--root', str(mutant), '--profile', 'plugin-component']
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8', check=False)
            assert result.returncode == 1 and case['sourceRule'] in result.stderr, (case['id'], result)
            print(f"{case['id']}: regression rejected by helper and CLI (exit {result.returncode})")
            checked += 1
    assert checked == 8, checked
    print(f'PASS: candidate instructions and {checked} negative source-policy mutations; model behavior NOT_RUN')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
