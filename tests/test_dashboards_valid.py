"""Validate dashboard + library-panel JSON for oc-plugin-core-app.

A core-datasource target is valid if it either names a shipped metric via
``ref`` (resolving to library-panels/<metric>.py) OR carries a non-empty
inline ``@metric`` source.
"""
import glob
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

METRICS = {
    os.path.splitext(os.path.basename(p))[0]
    for p in glob.glob(str(ROOT / "library-panels" / "*.py"))
}


def _targets(obj):
    """Recursively yield every core-datasource query target."""
    if isinstance(obj, dict):
        if obj.get("datasource", {}).get("type") == "core-datasource":
            for t in obj.get("targets", []):
                yield t
        for v in obj.values():
            yield from _targets(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _targets(v)


def _all_jsons():
    files = glob.glob(str(ROOT / "dashboards" / "*.json")) + glob.glob(
        str(ROOT / "library-panels" / "*.json")
    )
    assert files, "No dashboard or library-panel JSON files found"
    return files


def test_every_target_has_a_valid_ref_or_inline_source():
    for f in _all_jsons():
        with open(f) as fh:
            d = json.load(fh)
        for t in _targets(d):
            ref = (t.get("ref") or "").strip()
            src = (t.get("source") or "").strip()
            if ref:
                plugin, _, metric = ref.partition("/")
                assert plugin == "core-app", f"{f}: wrong plugin prefix in ref '{ref}'"
                assert metric in METRICS, f"{f}: ref '{ref}' has no library-panels/{metric}.py"
            else:
                assert src and "@metric" in src, (
                    f"{f}: target has neither a valid ref nor an inline @metric source"
                )


def test_no_dashboard_contains_base_currency():
    for f in glob.glob(str(ROOT / "dashboards" / "*.json")):
        with open(f) as fh:
            raw = fh.read()
        assert "base_currency" not in raw, (
            f"{f}: dashboard contains forbidden string 'base_currency'"
        )
