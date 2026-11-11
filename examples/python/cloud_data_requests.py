import os
import tempfile

from oortmem import Oort

# Answering an end user's data requests (GDPR access, portability, rectification, erasure) from
# your server, with a server key in OORT_API_KEY. The person asks you; you answer with this.
oort = Oort(mode="cloud", org="acme", project=None, project_config=False, key_sources=["env"])
ada = oort.scoped(user="user-ada")
ada.remember("I live in Oslo.")

# Access and portability: every memory Oort holds for them, in every state, as one file in the
# Oort export format. Hand it over as it is; `oort import <file>` reads it into any Oort.
copy = oort.end_users.export("user-ada")
path = os.path.join(tempfile.gettempdir(), "user-ada-memories.jsonl")
with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as f:
    f.write(copy.jsonl)
print(f"exported {copy.memories} memories")

# Rectification: save the corrected fact as them. Oort ends the wrong one (kept as history with
# an end date, never rewritten), and recall answers with the correction.
found = ada.recall("where do I live?").memories
ada.remember("Correction: I live in Bergen, not Oslo.")
# A wrong fact Oort did not end, or one they want gone even as history: forgetting deletes it.
if found and ada.explain(found[0].id).memory.status == "current":
    ada.forget(found[0].id)
    print("forgot the wrong fact")

# Erasure: everything of theirs at once. Their export is then empty, as for an id you never had.
print(f"erased {oort.end_users.erase('user-ada').memories} memories")
print(f"left {oort.end_users.export('user-ada').memories}")
oort.close()
