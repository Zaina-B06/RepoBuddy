"""Day-1 check: does the Meta Model API key work (and are the credits usable)?

Set MODEL_API_KEY in your terminal first, then: python backend/test_spark.py
"""
import os
import sys

import requests

key = os.environ.get("MODEL_API_KEY")
if not key:
    sys.exit("MODEL_API_KEY is not set in this terminal.")

r = requests.post(
    "https://api.meta.ai/v1/responses",
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    json={"model": "muse-spark-1.3", "input": "Say hello in one sentence."},
    timeout=60,
)
print("Status:", r.status_code)
print(r.text[:2000])
if r.status_code == 200:
    print("\nOK: the API works. Credits are usable.")
elif r.status_code == 401:
    print("\nKey is wrong, or not set in this terminal.")
else:
    print("\nNot working yet. If the error mentions billing, a hold or a restricted account, "
          "post this exact output in the hackathon Discord.")
