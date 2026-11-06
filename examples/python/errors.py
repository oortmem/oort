import time

from oortmem import Oort, OortError, OortNeedsKeyError, OortNotFoundError, OortUsageError


def recall_with_retry(oort: Oort, query: str, attempts: int = 3):
    """Retries only what may succeed later (network, busy, rate limits), as long as asked."""
    for attempt in range(attempts):
        try:
            return oort.recall(query)
        except OortError as e:
            if not e.retryable or attempt == attempts - 1:
                raise
            time.sleep(e.retry_after or 2**attempt)


with Oort(mode="local") as oort:
    print(len(recall_with_retry(oort, "deploy").memories), "memories")
    try:
        oort.explain("deadbeef-0000-4000-8000-000000000000")
    except OortNotFoundError:
        print("no such memory in this scope")  # outside the grant looks exactly like unknown
    try:
        oort.recall("x", limit=500)
    except OortUsageError as e:
        print(e.code, e.reason)  # usage invalid-argument: names the field, never its value
    try:
        oort.observe(user="We deploy on Fridays now.", assistant="Noted.")
    except OortNeedsKeyError as e:
        print("not saved:", e.role, "needs", e.env_var, "or:", e.fix)
