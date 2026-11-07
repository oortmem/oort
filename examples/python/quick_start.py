from oortmem import Oort, format_for_prompt

with Oort() as oort:  # mode="auto": what `oort setup` chose on this machine
    r = oort.recall("how do we deploy?")
    prompt = format_for_prompt(r)  # the escaped <oort-memory> block; "" when nothing matched
    oort.observe(user="We deploy on Fridays now.", assistant="Noted: Fridays.")
