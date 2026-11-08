import asyncio
from dataclasses import dataclass

from agents import Agent, RunContextWrapper, Runner

from oortmem import AsyncOort, format_for_prompt


@dataclass
class Turn:
    question: str


async def main() -> None:
    async with AsyncOort() as root:
        oort = root.scoped(agent="support-bot", judge_role="agent")

        # Recall goes through dynamic instructions, never by rewriting the history.
        async def instructions(ctx: RunContextWrapper[Turn], agent: Agent[Turn]) -> str:
            return f"You help customers.\n{format_for_prompt(await oort.recall(ctx.context.question))}"

        agent = Agent[Turn](name="support", instructions=instructions)
        question = "When do we deploy billing?"
        result = await Runner.run(agent, question, context=Turn(question))
        print(result.final_output)
        await oort.observe(user=question, assistant=str(result.final_output))  # after answering


asyncio.run(main())
