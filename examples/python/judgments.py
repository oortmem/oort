from oortmem import Oort

# Expert role: host code where a person really decided (a review UI). Never hand it to a model.
with Oort(mode="local", judge_role="expert", operator="ada") as oort:
    oort.judge.record(
        subject="Post claims a miracle cure, no source",
        verdict="rejected",
        reason="Health claim without a source.",
        domain="content",
        by="ada",
    )
    agent = oort.scoped(judge_role="agent")  # what model-facing tools get
    r = agent.judge.apply("Post says a herb cures diabetes, links nothing", domain="content")
    print(r.status, r.prediction.verdict if r.prediction else None, len(r.precedents))
