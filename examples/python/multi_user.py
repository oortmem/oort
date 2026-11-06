from oortmem import Oort

# One handle per process, every option explicit: your tenant, no project, no repository config.
oort = Oort(mode="local", org="acme", project=None, project_config=False)


def handle_message(user_id: str, text: str) -> str:
    mem = oort.scoped(user=user_id, agent="support-bot")  # this user's Planet, nothing else
    context = mem.recall(text, limit=5)
    reply = f"I found {len(context.memories)} things I know about you."
    mem.observe(user=text, assistant=reply)  # after answering: it can take seconds
    return reply


print(handle_message("u-123", "I prefer email over phone calls."))
print(handle_message("u-456", "How do you contact me?"))  # never sees u-123's memories
oort.close()
