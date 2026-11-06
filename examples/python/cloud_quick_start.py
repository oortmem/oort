from oortmem import Oort, format_for_prompt

# The Oort key comes from OORT_API_KEY (or `oort login`); cloud mode needs no Node.
with Oort(mode="cloud", project="acme-web") as oort:
    r = oort.recall("how do we deploy?", limit=5)
    print(format_for_prompt(r))
    # turn_ref makes a retry safe: Oort Cloud answers duplicate=True instead of saving twice.
    saved = oort.observe(user="We deploy on Fridays now.", assistant="Noted.", turn_ref="chat-42:7")
    print(saved.outcome, saved.duplicate)
