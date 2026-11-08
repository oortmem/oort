from oortmem import Oort

# Oort Cloud with a server key ("Acts for end users", made on oortcloud.dev/account) in
# OORT_API_KEY. An Oort Cloud without per-user memory refuses end users (end-users-unsupported).
oort = Oort(mode="cloud", org="acme", project=None, project_config=False, key_sources=["env"])


def handle_message(user_id: str, text: str) -> str:
    mem = oort.scoped(user=user_id, agent="support-bot")  # sends Oort-User: their Planet only
    context = mem.recall(text, limit=5)
    reply = f"I found {len(context.memories)} things I know about you."
    mem.observe(user=text, assistant=reply)  # after answering: it can take seconds
    return reply


print(handle_message("u-123", "I prefer email over phone calls."))
count = oort.end_users.count()  # the account's end users: server code only
print(f"{count.end_users} of {count.limit} end users")
print("erased", oort.end_users.erase("u-123").memories, "memories")  # a deletion request
oort.close()
