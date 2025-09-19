import os
import sys
import json
import time
import pathlib
import requests

BASE_URL = "https://api.sportradar.com/ncaafb/trial/v7/en/teams/{team_id}/full_roster.json"


def main():
    root = pathlib.Path(__file__).parent
    teams_path = root / "sportsradar-teams.json"
    out_dir = root / "output" / "rosters"
    out_dir.mkdir(parents=True, exist_ok=True)
    combined_path = root / "output" / "all_team_rosters.json"

    api_key = os.environ.get("SPORTRADAR_API_KEY")
    if not api_key:
        print("ERROR: Set SPORTRADAR_API_KEY environment variable.", file=sys.stderr)
        print("PowerShell example:", file=sys.stderr)
        print('  $env:SPORTRADAR_API_KEY="YOUR_KEY_HERE"', file=sys.stderr)
        sys.exit(1)

    try:
        with teams_path.open("r", encoding="utf-8") as f:
            teams_doc = json.load(f)
    except Exception as e:
        print(f"ERROR: Failed to read {teams_path}: {e}", file=sys.stderr)
        sys.exit(1)

    teams = teams_doc.get("teams", [])
    if not teams:
        print(f"ERROR: No teams found in {teams_path}.", file=sys.stderr)
        sys.exit(1)

    session = requests.Session()
    headers = {"accept": "application/json"}
    params = {"api_key": api_key}

    results = []
    errors = []

    for idx, team in enumerate(teams, start=1):
        team_id = team.get("id")
        alias = team.get("alias") or "team"
        market = team.get("market")
        name = team.get("name")

        if not team_id:
            errors.append({"team_id": None, "alias": alias, "status": "missing team id"})
            continue

        url = BASE_URL.format(team_id=team_id)

        try:
            resp = fetch_with_retries(session, url, headers, params, retries=4, backoff=2.0)
            if resp is None:
                errors.append({
                    "team_id": team_id,
                    "alias": alias,
                    "status": "failed after retries"
                })
                continue

            if resp.status_code == 200:
                data = resp.json()
                # include meta so combined file is self-describing
                data["_team_meta"] = {"id": team_id, "alias": alias, "market": market, "name": name}
                results.append(data)

                # per-team file
                per_team_path = out_dir / f"{alias}_{team_id}.json"
                with per_team_path.open("w", encoding="utf-8") as outf:
                    json.dump(data, outf, ensure_ascii=False, indent=2)
            else:
                errors.append({
                    "team_id": team_id,
                    "alias": alias,
                    "status": resp.status_code,
                    "detail": safe_text(resp)
                })

        except Exception as e:
            errors.append({"team_id": team_id, "alias": alias, "error": str(e)})

        if idx % 10 == 0:
            print(f"Processed {idx}/{len(teams)}")

        # gentle pacing; adjust if you hit rate limits
        time.sleep(0.15)

    combined = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "count": len(results),
        "errors": errors,
        "rosters": results,
    }

    combined_path.parent.mkdir(parents=True, exist_ok=True)
    with combined_path.open("w", encoding="utf-8") as f:
        json.dump(combined, f, ensure_ascii=False, indent=2)

    print(f"Done. Success: {len(results)}. Errors: {len(errors)}.")
    print(f"Combined file: {combined_path}")
    print(f"Per-team files directory: {out_dir}")


def safe_text(resp):
    try:
        return (resp.text or "")[:500]
    except Exception:
        return None


def fetch_with_retries(session, url, headers, params, retries=3, backoff=1.5, timeout=30):
    delay = 0
    for attempt in range(retries):
        if delay:
            time.sleep(delay)
        try:
            r = session.get(url, headers=headers, params=params, timeout=timeout)
        except requests.RequestException:
            r = None

        if r is None:
            delay = max(1, int(backoff ** (attempt + 1)))
            continue

        if r.status_code == 429:
            # honor Retry-After if present
            retry_after = int(r.headers.get("Retry-After", "1"))
            delay = max(retry_after, int(backoff ** (attempt + 1)))
            continue

        if 500 <= r.status_code < 600:
            delay = int(backoff ** (attempt + 1))
            continue

        return r

    return None


if __name__ == "__main__":
    main()