"""Day-1 check: can we reach a model? Works with Meta Model API or any OpenAI-compatible host.

Set these in your terminal (or in backend/.env), then: python test_spark.py
    LLM_BASE_URL   default https://api.meta.ai/v1
    LLM_MODEL      default muse-spark-1.3
    LLM_API_KEY    (MODEL_API_KEY also works)
"""
import os
import sys
from pathlib import Path

import requests

env_file = Path(__file__).resolve().with_name(".env")
if env_file.exists():
    for line in env_file.read_text().splitlines():
        if "=" in line and not line.strip().startswith("#"):
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"'))

base = os.environ.get("LLM_BASE_URL", "https://api.meta.ai/v1").rstrip("/")
model = os.environ.get("LLM_MODEL", "muse-spark-1.3")
key = os.environ.get("LLM_API_KEY") or os.environ.get("MODEL_API_KEY")
if not key:
    sys.exit("Set LLM_API_KEY (or MODEL_API_KEY) first.")

headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
r = requests.post(f"{base}/chat/completions", headers=headers, timeout=120,
                  json={"model": model, "messages": [{"role": "user", "content": "Say hello in one sentence."}]})
if r.status_code == 404 and "api.meta.ai" in base:   # Meta's quickstart uses the Responses endpoint
    r = requests.post(f"{base}/responses", headers=headers, timeout=120,
                      json={"model": model, "input": "Say hello in one sentence."})

print(f"Provider: {base}   Model: {model}")
print("Status:", r.status_code)
print(r.text[:1500])
if r.status_code == 200:
    print("\nOK: model reachable.")
elif r.status_code == 401:
    print("\nKey is wrong, or not set in this terminal.")
else:
    print("\nNot working. If the error mentions billing, a hold or a restricted account, it's the card issue.")
