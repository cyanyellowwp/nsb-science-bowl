#!/usr/bin/env bash
#
# One-command verification: syntax-check every JS file and validate the JSON
# question banks. Run this before saying "done" on any change.
#
# Usage:  ./scripts/check.sh
#
set -e

cd "$(dirname "$0")/.."

# ---------- Syntax check JS ----------
echo "🔍 Syntax checking JS files..."
JS_FILES=(
  agent.js
  app.js
  dashboard.js
  llm-generator.js
  llm-judge.js
  mock-api.js
  progress.js
  tests.js
)
for f in "${JS_FILES[@]}"; do
  if [ -f "$f" ]; then
    node --check "$f" && echo "  ✓ $f"
  else
    echo "  ⚠ $f missing"
  fi
done

# Test files
for f in tests/*.test.js; do
  [ -e "$f" ] || continue
  node --check "$f" && echo "  ✓ $f"
done

# ---------- JSON validity ----------
echo ""
echo "🔍 Validating JSON banks..."
for f in questions.json corpus-doe.json; do
  if [ -f "$f" ]; then
    python3 -c "import json; d=json.load(open('$f')); print(f'  ✓ $f — {len(d.get(\"concepts\", d.get(\"rounds\", [])))} concepts/rounds')"
  fi
done

# ---------- Schema sanity ----------
echo ""
echo "🔍 Checking question bank schema..."
python3 - <<'PY'
import json, sys
errors = 0
for path in ['questions.json', 'corpus-doe.json']:
    try:
        d = json.load(open(path))
    except FileNotFoundError:
        continue
    concepts = d.get('concepts') or []
    if not concepts and 'rounds' not in d:
        print(f'  ⚠ {path}: no concepts and no rounds')
        errors += 1
        continue
    for c in concepts:
        if not c.get('id'):
            print(f'  ⚠ {path}: concept missing id'); errors += 1
        if not c.get('tossup_variants') or not c.get('bonus_variants'):
            print(f"  ⚠ {path}: concept {c.get('id')} missing variants"); errors += 1
        for v in (c.get('tossup_variants') or []) + (c.get('bonus_variants') or []):
            if not v.get('type') or not v.get('answer'):
                print(f"  ⚠ {path}: variant {v.get('id')} missing type/answer"); errors += 1
            if v.get('type') == 'multiple_choice' and not v.get('answer_text'):
                # answer_text is optional but useful — warn quietly
                pass
    print(f"  ✓ {path}: {len(concepts)} concepts validated")
sys.exit(errors)
PY

echo ""
echo "🔍 Running content linter..."
python3 "$(dirname "$0")/lint_questions.py" || {
  echo ""
  echo "⚠️  Content linter found issues. Run:"
  echo "   python3 scripts/lint_questions.py --report lint-report.md"
  echo "   python3 scripts/lint_questions.py --quarantine     # to move bad entries aside"
  exit 1
}

echo ""
echo "✅ All checks passed. Open http://localhost:8766/?tests=1 to run the browser test suite."
