import json
import os
from pathlib import Path

import pytest

_real_unlink = os.unlink


def _tolerant_unlink(path, *args, **kwargs):
    try:
        return _real_unlink(path, *args, **kwargs)
    except PermissionError:
        return None


os.unlink = _tolerant_unlink
CONTRACT = str(Path(__file__).resolve().parents[2] / "contracts" / "SpecMatchContract.py")


def analysis_response(verdict="compatible", confidence="high", statuses=None, fabricated=False):
    statuses = statuses or ["match", "match", "match", "match", "match"]
    names = ["inputs", "outputs", "errors", "side_effects", "constraints"]
    checks = []
    for name, status in zip(names, statuses):
        source = "specification" if name in ("inputs", "outputs") else "implementation"
        excerpt = "accepts a string" if source == "specification" else "returns a string"
        if fabricated and name == "inputs":
            excerpt = "this text was never submitted"
        checks.append({
            "name": name,
            "status": status,
            "detail": f"{name} behavior is {status}.",
            "evidence": [{"source": source, "excerpt": excerpt}],
        })
    return json.dumps({
        "verdict": verdict,
        "confidence": confidence,
        "explanation": "The supplied behaviors were compared across the stable compatibility dimensions.",
        "checks": checks,
    })


def payload(constraints=""):
    return json.dumps({
        "specification": "The endpoint accepts a string and returns a string. Invalid values return code E_INPUT.",
        "implementation": "The endpoint accepts a string and returns a string. Invalid values return code E_INPUT.",
        "constraints": constraints,
    })


@pytest.fixture
def deploy(direct_deploy, direct_vm, direct_alice):
    contract = direct_deploy(CONTRACT)
    direct_vm.sender = direct_alice
    direct_vm.mock_llm(r".*", analysis_response())
    return contract
