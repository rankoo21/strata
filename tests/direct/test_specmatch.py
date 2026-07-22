import json

from conftest import analysis_response, payload


def submit(deploy, request_id="check-1", now=1700000000000):
    return deploy.submit_check(request_id, payload(), now)


def test_compatible_result_is_persisted(deploy):
    result = submit(deploy)
    assert result["verdict"] == "compatible"
    assert result["confidence"] == "high"
    assert len(result["matched_requirements"]) == 5
    assert result["mismatches"] == []
    assert result["sender"].startswith("0x")
    assert deploy.get_result(result["sender"], "check-1") == result


def test_breaking_and_unclear_results(deploy, direct_vm):
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", analysis_response("breaking", "high", ["match", "mismatch", "match", "match", "match"]))
    breaking = submit(deploy, "breaking")
    assert breaking["verdict"] == "breaking"
    assert breaking["mismatches"][0]["requirement"] == "outputs"
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", analysis_response("unclear", "low", ["match", "unclear", "match", "match", "match"]))
    assert submit(deploy, "unclear")["verdict"] == "unclear"


def test_constraints_and_grounded_evidence(deploy):
    result = deploy.submit_check("constrained", payload("Responses must remain JSON."), 1700000000000)
    assert result["evidence"]
    submitted = json.loads(payload("Responses must remain JSON."))
    for evidence in result["evidence"]:
        assert evidence["excerpt"] in submitted[evidence["source"]]


def test_duplicate_is_idempotent_and_not_recounted(deploy):
    first = submit(deploy)
    second = submit(deploy)
    assert first == second
    assert deploy.get_summary()["total"] == 1
    assert len(deploy.get_results(0, 20)) == 1


def test_same_request_id_different_senders(deploy, direct_vm, direct_bob):
    alice = submit(deploy)
    direct_vm.sender = direct_bob
    bob = submit(deploy)
    assert alice["key"] != bob["key"]
    assert deploy.get_result(alice["sender"], "check-1") == alice
    assert deploy.get_result(bob["sender"], "check-1") == bob
    assert deploy.get_summary()["total"] == 2


def test_results_are_newest_first_and_bounded(deploy):
    for index in range(3):
        submit(deploy, f"request-{index}", 1700000000000 + index)
    assert [item["request_id"] for item in deploy.get_results(0, 20)] == ["request-2", "request-1", "request-0"]
    assert len(deploy.get_results(0, 999)) == 3
    assert deploy.get_results(0, 0) == []


def test_summary_counts(deploy, direct_vm):
    submit(deploy, "compatible")
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", analysis_response("breaking", "medium", ["mismatch"] * 5))
    submit(deploy, "breaking")
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", analysis_response("unclear", "low", ["unclear"] * 5))
    submit(deploy, "unclear")
    assert deploy.get_summary() == {"total": 3, "compatible": 1, "breaking": 1, "unclear": 1}


def test_malformed_and_missing_payload_fields(deploy, direct_vm):
    with direct_vm.expect_revert("payload_json is malformed"):
        deploy.submit_check("bad-json", "{", 1)
    with direct_vm.expect_revert("specification is required"):
        deploy.submit_check("missing", json.dumps({"specification": " ", "implementation": "x"}), 1)
    with direct_vm.expect_revert("implementation must be a string"):
        deploy.submit_check("missing-two", json.dumps({"specification": "x"}), 1)


def test_request_id_and_timestamp_guards(deploy, direct_vm):
    with direct_vm.expect_revert("request_id length is invalid"):
        deploy.submit_check(" ", payload(), 1)
    with direct_vm.expect_revert("request_id contains invalid characters"):
        deploy.submit_check("bad id", payload(), 1)
    with direct_vm.expect_revert("now_ms is out of range"):
        deploy.submit_check("time", payload(), -1)


def arm_validator(deploy, direct_vm, response=None):
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", response or analysis_response())
    submit(deploy, "validator")


def leader_dict(verdict="compatible", confidence="high", statuses=None, fabricated=False):
    return json.loads(analysis_response(verdict, confidence, statuses, fabricated)) | {"statuses": statuses or ["match"] * 5}


def test_validator_accepts_matching_substance(deploy, direct_vm):
    arm_validator(deploy, direct_vm)
    assert direct_vm.run_validator(leader_result=leader_dict()) is True


def test_validator_rejects_wrong_verdict(deploy, direct_vm):
    arm_validator(deploy, direct_vm)
    assert direct_vm.run_validator(leader_result=leader_dict("breaking")) is False


def test_validator_rejects_material_status_omission(deploy, direct_vm):
    statuses = ["match", "mismatch", "match", "match", "match"]
    arm_validator(deploy, direct_vm, analysis_response("breaking", "high", statuses))
    assert direct_vm.run_validator(leader_result=leader_dict("breaking", "high", ["match"] * 5)) is False


def test_validator_rejects_fabricated_evidence(deploy, direct_vm):
    arm_validator(deploy, direct_vm)
    assert direct_vm.run_validator(leader_result=leader_dict(fabricated=True)) is False


def test_validator_rejects_non_return_result(deploy, direct_vm):
    arm_validator(deploy, direct_vm)
    assert direct_vm.run_validator(leader_error=Exception("[LLM_ERROR] boom")) is False


def test_persistence_rejects_fabricated_evidence(deploy, direct_vm):
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", analysis_response(fabricated=True))
    with direct_vm.expect_revert("Evidence excerpt was not copied exactly"):
        submit(deploy, "fabricated")
