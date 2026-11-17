from oortmem import Oort

# A support agent's memory of one customer. Each turn carries when it was said (`at`), and a date
# in the fact ("until", "starting") sets when the fact holds.
with Oort(mode="local") as oort:
    oort.observe(user="Acme is on the Starter plan until 31 March 2026.", assistant="Noted.", at="2026-03-02T09:00:00Z")
    oort.observe(user="Acme is on the Business plan starting 1 April 2026.", assistant="Noted.", at="2026-03-30T09:00:00Z")

    question = "Which plan is Acme on?"

    # What is true now: the Starter fact has ended, so only the Business plan comes back.
    print([m.text for m in oort.recall(question).memories])

    # What was true on a date: `as_of` reads the facts that held then.
    print([m.text for m in oort.recall(question, as_of="2026-03-15").memories])

    # Every version, each with the dates it held. The ended fact is kept as history.
    for m in oort.recall(question, mode="history").memories:
        print(m.valid_from, m.valid_to, m.text)
