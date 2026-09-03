from pathlib import Path

repo_root = Path(__file__).resolve().parents[1]
candidate = (repo_root / "artifacts/api-server/src/lib/strategies/eth420SixStepCandidate.ts").read_text()
auto = (repo_root / "artifacts/api-server/src/lib/autoTrader.ts").read_text()

required = [
    (candidate, 'ordinary_martingale_owned'),
    (candidate, 'earlier_candidate_unresolved'),
    (auto, 'Promise<"special" | "regular" | "hold">'),
    (auto, 'if (candidateRoad === "regular")'),
]

missing = [needle for text, needle in required if needle not in text]
if missing:
    raise SystemExit(f"router verification failed; missing markers: {missing}")
