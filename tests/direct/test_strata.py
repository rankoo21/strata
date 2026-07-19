import json

from conftest import (
    corroborate_response,
    contradict_response,
    new_response,
    relation_response,
    relation_dict,
)


# A testimony that shares strong lexical overlap with the seeded claim so the
# deterministic overlap guard accepts a corroboration or contradiction.
BRIDGE_CLAIM = "The bridge closed and water reached the second step by noon."
BRIDGE_TEXT = "I saw the bridge closed and the water reached the second step by noon."
CORROBORATE_TEXT = "The bridge closed by noon and the water had reached the second step."
CONTRADICT_TEXT = "The bridge stayed open and the water never reached the second step that noon."


def _open_with_first_layer(deploy, direct_vm):
    """Open a column and drop the first testimony as a new floating layer."""
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", new_response(band="moderate", claim=BRIDGE_CLAIM))
    column_id = deploy.open_column("The bridge closure", 1000)
    res = deploy.add_testimony(column_id, BRIDGE_TEXT, "witnessed", 2000)
    return column_id, res["layerId"]


# ---------------------------------------------------------------------------
# open_column
# ---------------------------------------------------------------------------

def test_open_column_creates_column(deploy):
    column_id = deploy.open_column("The bridge closure", 1000)
    column = deploy.get_column(column_id)
    assert column is not None
    assert column["subject"] == "The bridge closure"
    assert column["layerIds"] == []
    assert column["testimonyCount"] == 0


def test_open_column_requires_subject(deploy, direct_vm):
    with direct_vm.expect_revert("Choose a subject"):
        deploy.open_column("   ", 1000)


# ---------------------------------------------------------------------------
# add_testimony: new / corroborate / contradict
# ---------------------------------------------------------------------------

def test_add_testimony_requires_words(deploy, direct_vm):
    column_id = deploy.open_column("The bridge closure", 1000)
    with direct_vm.expect_revert("needs words"):
        deploy.add_testimony(column_id, "   ", "witnessed", 2000)


def test_add_testimony_new_claim_floats(deploy, direct_vm):
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)
    layer = deploy.get_layer(layer_id)
    assert layer is not None
    assert layer["relation"] == "new"
    assert layer["supporters"] == 1
    assert layer["state"] == "floating"
    assert layer["faultFlag"] is False


def test_add_testimony_corroborates_and_sinks(deploy, direct_vm, direct_alice, direct_bob):
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)

    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", corroborate_response(target=0, band="strong", claim=BRIDGE_CLAIM))
    # A DISTINCT author corroborates, so weight and unique supporters grow.
    direct_vm.sender = direct_bob
    res = deploy.add_testimony(column_id, CORROBORATE_TEXT, "heard", 3000)
    assert res["relation"] == "corroborates"

    layer = deploy.get_layer(layer_id)
    assert layer["supporters"] == 2
    assert layer["weight"] > 100
    assert layer["state"] == "corroborated"
    # Corroborated layers sink: depth grows past the surface.
    assert layer["depth"] > 0


def test_layer_hardens_past_threshold(deploy, direct_vm, direct_alice, direct_bob, direct_charlie):
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)

    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", corroborate_response(target=0, band="strong", claim=BRIDGE_CLAIM))
    # Three DISTINCT authors are required to harden. alice seeded the layer;
    # bob and charlie each corroborate once.
    direct_vm.sender = direct_bob
    deploy.add_testimony(column_id, CORROBORATE_TEXT, "heard", 3000)
    direct_vm.sender = direct_charlie
    deploy.add_testimony(column_id, CORROBORATE_TEXT, "recorded", 4000)

    layer = deploy.get_layer(layer_id)
    # weight: 100 base + 300 + 300 = 700 >= 600, unique supporters 3 >= 3 -> hardened.
    assert layer["weight"] >= 600
    assert layer["supporters"] >= 3
    assert layer["hardened"] is True
    assert layer["state"] == "hardened"
    assert layer["depth"] >= 750


def test_repeated_same_author_cannot_harden(deploy, direct_vm, direct_alice):
    # The reviewer's core concern: repeated UNAUTHENTICATED testimony from one
    # author must not harden a claim. alice seeds the layer and then corroborates
    # it many times herself; the layer must stay a single-supporter floating
    # claim and never harden.
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)

    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", corroborate_response(target=0, band="strong", claim=BRIDGE_CLAIM))
    for t in range(3000, 3000 + 5 * 1000, 1000):
        # Same sender (alice) every time.
        deploy.add_testimony(column_id, CORROBORATE_TEXT, "heard", t)

    layer = deploy.get_layer(layer_id)
    # Still one unique supporter, no extra weight, never hardened.
    assert layer["supporters"] == 1
    assert layer["weight"] == 100
    assert layer["hardened"] is False
    assert layer["state"] == "floating"


def test_isolated_claim_cannot_self_harden(deploy, direct_vm):
    # Many separate "new" claims never harden: each is its own floating layer.
    direct_vm.clear_mocks()
    column_id = deploy.open_column("The bridge closure", 1000)
    for i in range(4):
        direct_vm.clear_mocks()
        direct_vm.mock_llm(
            r".*", new_response(band="strong", claim=f"Separate observation numbered {i}")
        )
        deploy.add_testimony(column_id, f"An entirely separate observation numbered {i}.", "inferred", 2000 + i)
    layers = deploy.get_layers(column_id, 0, 20)
    assert len(layers) == 4
    for layer in layers:
        assert layer["hardened"] is False
        assert layer["state"] == "floating"


# ---------------------------------------------------------------------------
# fault detection
# ---------------------------------------------------------------------------

def test_contradiction_creates_fault(deploy, direct_vm):
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)

    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", contradict_response(target=0, band="strong", claim="The bridge stayed open at noon."))
    res = deploy.add_testimony(column_id, CONTRADICT_TEXT, "witnessed", 3000)
    assert res["relation"] == "contradicts"
    assert res["faultId"] is not None

    layer = deploy.get_layer(layer_id)
    assert layer["faultFlag"] is True
    assert layer["contradictions"] >= 1
    assert layer["state"] == "faulted"

    faults = deploy.get_faults(column_id, 0, 20)
    assert len(faults) == 1
    assert faults[0]["layerId"] == layer_id
    assert faults[0]["holdingSide"] in ("deep", "surface", "even")


def test_fabricated_corroboration_falls_back_to_new(deploy, direct_vm):
    # The model claims corroboration but the testimony shares no language with
    # the existing layer. The deterministic overlap guard rejects it and the
    # testimony becomes a new floating claim instead of rewriting history.
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)

    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", corroborate_response(target=0, band="strong", claim="Unrelated weather note"))
    res = deploy.add_testimony(
        column_id, "Completely unrelated chatter regarding distant mountain weather.", "inferred", 3000
    )
    assert res["relation"] == "new"

    original = deploy.get_layer(layer_id)
    # The original layer was not touched.
    assert original["supporters"] == 1


# ---------------------------------------------------------------------------
# take_reading
# ---------------------------------------------------------------------------

def test_take_reading_recomputes(deploy, direct_vm, direct_alice, direct_bob):
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)

    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", corroborate_response(target=0, band="strong", claim=BRIDGE_CLAIM))
    direct_vm.sender = direct_bob
    deploy.add_testimony(column_id, CORROBORATE_TEXT, "heard", 3000)

    reading = deploy.take_reading(column_id, 5000)
    assert reading["layers"] == 1
    assert reading["corroborated"] >= 1


def test_take_reading_requires_layers(deploy, direct_vm):
    column_id = deploy.open_column("Empty column", 1000)
    with direct_vm.expect_revert("Nothing here corroborates yet"):
        deploy.take_reading(column_id, 2000)


# ---------------------------------------------------------------------------
# paged views
# ---------------------------------------------------------------------------

def test_get_layers_surface_to_deep(deploy, direct_vm, direct_alice, direct_bob, direct_charlie):
    column_id, hardened_layer = _open_with_first_layer(deploy, direct_vm)
    # Harden the first layer so it sinks deep (three distinct authors).
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", corroborate_response(target=0, band="strong", claim=BRIDGE_CLAIM))
    direct_vm.sender = direct_bob
    deploy.add_testimony(column_id, CORROBORATE_TEXT, "heard", 3000)
    direct_vm.sender = direct_charlie
    deploy.add_testimony(column_id, CORROBORATE_TEXT, "recorded", 4000)

    # Add a fresh floating claim near the surface.
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", new_response(band="slight", claim="A late surface rumor"))
    direct_vm.sender = direct_alice
    deploy.add_testimony(column_id, "A late surface rumor about the lights.", "heard", 5000)

    layers = deploy.get_layers(column_id, 0, 20)
    assert len(layers) == 2
    # Surface to deep: shallow depth first.
    assert layers[0]["depth"] <= layers[1]["depth"]
    assert layers[-1]["id"] == hardened_layer


def test_get_columns_newest_first(deploy):
    ids = []
    for i in range(3):
        ids.append(deploy.open_column(f"Subject {i}", 1000 + i))
    columns = deploy.get_columns(0, 20)
    assert len(columns) == 3
    assert columns[0]["id"] == ids[-1]


# ---------------------------------------------------------------------------
# archive_core + summary
# ---------------------------------------------------------------------------

def test_archive_core_snapshots_hardened_layers(deploy, direct_vm, direct_alice, direct_bob, direct_charlie):
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", corroborate_response(target=0, band="strong", claim=BRIDGE_CLAIM))
    direct_vm.sender = direct_bob
    deploy.add_testimony(column_id, CORROBORATE_TEXT, "heard", 3000)
    direct_vm.sender = direct_charlie
    deploy.add_testimony(column_id, CORROBORATE_TEXT, "recorded", 4000)

    core_id = deploy.archive_core(column_id, "0xcafe", 6000)
    assert core_id is not None

    cores = deploy.get_cores(column_id, 0, 20)
    assert len(cores) == 1
    assert cores[0]["mockTxHash"] == "0xcafe"
    assert len(cores[0]["hardenedLayers"]) == 1
    assert cores[0]["hardenedLayers"][0]["hardened"] is True


def test_summary_counts(deploy, direct_vm):
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", contradict_response(target=0, band="strong", claim="Open at noon"))
    deploy.add_testimony(column_id, CONTRADICT_TEXT, "witnessed", 3000)

    summary = deploy.get_summary()
    assert summary["columns"] == 1
    assert summary["layers"] == 1
    assert summary["testimonies"] == 2
    assert summary["faults"] == 1


# ---------------------------------------------------------------------------
# add_testimony: SUBSTANCE-LEVEL consensus validator (adversarial)
#
# These exercise validator_fn directly through direct_vm.run_validator(). The
# leader mock is armed by a real add_testimony call against a seeded layer, so
# the captured validator re-runs the same classification. Each test feeds a
# candidate peer classification and asserts whether the validator agrees. The
# validator judges SUBSTANCE (relation label, weight band, the target layer it
# points at, and the canonical claim), never output shape alone.
# ---------------------------------------------------------------------------

def _arm_corroborate_validator(deploy, direct_vm):
    """Seed a column with one layer, then run a corroborating testimony so the
    validator is captured with a corroborate-against-layer-0 leader mock."""
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", corroborate_response(target=0, band="strong", claim=BRIDGE_CLAIM))
    deploy.add_testimony(column_id, CORROBORATE_TEXT, "heard", 3000)
    return column_id, layer_id


def test_validator_agrees_on_matching_substance(deploy, direct_vm):
    # A peer that reaches the same relation, band, target layer, and a claim
    # that restates the same fact is consensus. The validator agrees.
    _arm_corroborate_validator(deploy, direct_vm)
    theirs = relation_dict(
        "corroborates", 0, "strong",
        "The bridge was closed and water was at the second step around noon.",
    )
    assert direct_vm.run_validator(leader_result=theirs) is True


def test_validator_rejects_relation_disagreement(deploy, direct_vm):
    # Same band and target, but the peer calls it a contradiction. Relation
    # routes the whole state update, so this well-formed but substantively
    # different classification is rejected.
    _arm_corroborate_validator(deploy, direct_vm)
    theirs = relation_dict("contradicts", 0, "strong", BRIDGE_CLAIM)
    assert direct_vm.run_validator(leader_result=theirs) is False


def test_validator_rejects_band_disagreement(deploy, direct_vm):
    # Same relation and target, but a different weight band would settle the
    # layer by a different amount. Rejected.
    _arm_corroborate_validator(deploy, direct_vm)
    theirs = relation_dict("corroborates", 0, "slight", BRIDGE_CLAIM)
    assert direct_vm.run_validator(leader_result=theirs) is False


def test_validator_rejects_non_matching_target_layer(deploy, direct_vm):
    # The peer agrees on relation and band but points corroboration at a
    # DIFFERENT layer index (a non-matching target). Corroborating different
    # history is a substantive disagreement, so it is rejected.
    column_id, layer_id = _open_with_first_layer(deploy, direct_vm)
    # Add a second, distinct floating layer so index 1 exists.
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", new_response(band="slight", claim="A separate lamp-post note"))
    deploy.add_testimony(column_id, "A wholly separate note about a distant lamp post.", "heard", 2500)

    # Arm the validator with a corroborate-against-layer-0 leader.
    direct_vm.clear_mocks()
    direct_vm.mock_llm(r".*", corroborate_response(target=0, band="strong", claim=BRIDGE_CLAIM))
    deploy.add_testimony(column_id, CORROBORATE_TEXT, "recorded", 3000)

    theirs = relation_dict("corroborates", 1, "strong", BRIDGE_CLAIM)
    assert direct_vm.run_validator(leader_result=theirs) is False


def test_validator_rejects_divergent_claim_substance(deploy, direct_vm):
    # Relation, band, and target all line up, but the peer's canonical claim
    # restates a substantively different fact (shares no meaningful words). The
    # nodes are not asserting the same thing, so the validator disagrees.
    _arm_corroborate_validator(deploy, direct_vm)
    theirs = relation_dict(
        "corroborates", 0, "strong",
        "Mountain snowfall totals climbed sharply overnight elsewhere.",
    )
    assert direct_vm.run_validator(leader_result=theirs) is False


def test_validator_rejects_non_return_result(deploy, direct_vm):
    # A leader that errored (no Return value) can never be agreed with.
    _arm_corroborate_validator(deploy, direct_vm)
    assert direct_vm.run_validator(leader_error=Exception("[LLM_ERROR] boom")) is False


def test_validator_rejects_truth_fragment_padded_with_inventions(deploy, direct_vm):
    _arm_corroborate_validator(deploy, direct_vm)
    padded = relation_dict(
        "corroborates",
        0,
        "strong",
        (
            "The bridge closed and water reached the second step by noon, while aliens "
            "landed nearby, gold was discovered, the mayor resigned, and a volcano erupted."
        ),
    )
    assert direct_vm.run_validator(leader_result=padded) is False


def test_persistence_rejects_canonical_claim_ungrounded_in_testimony(deploy, direct_vm):
    column_id = deploy.open_column("The bridge closure", 1000)
    direct_vm.clear_mocks()
    direct_vm.mock_llm(
        r".*",
        new_response(
            band="strong",
            claim="Aliens landed nearby and a volcano erupted while the mayor resigned.",
        ),
    )
    with direct_vm.expect_revert("canonical claim was not grounded"):
        deploy.add_testimony(column_id, BRIDGE_TEXT, "witnessed", 2000)
    assert deploy.get_layers(column_id, 0, 20) == []
