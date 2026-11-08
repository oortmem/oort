from crewai import LLM, Agent, Crew, Task

from oortmem import Oort, format_for_prompt


def answer(oort: Oort, question: str) -> str:
    memory = format_for_prompt(oort.recall(question))
    agent = Agent(
        role="Support agent",
        goal="Answer the customer's question from what the team knows.",
        backstory="You help customers.",
        llm=LLM(model="anthropic/claude-haiku-5-5"),
    )
    # The memory goes in as an input, so braces in a stored memory are never a template.
    task = Task(
        description="Answer this question: {question}\n\nWhat you remember:\n{memory}",
        expected_output="A short answer.",
        agent=agent,
    )
    # CrewAI's own memory stays off: Oort is the memory.
    crew = Crew(agents=[agent], tasks=[task], memory=False)
    reply = crew.kickoff(inputs={"question": question, "memory": memory}).raw
    oort.observe(user=question, assistant=reply)  # after answering: it can take seconds
    return reply


with Oort() as root:
    print(answer(root.scoped(agent="support-crew", judge_role="agent"), "When do we deploy billing?"))
