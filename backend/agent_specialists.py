"""Role-scoped specialist agents used by the orchestrator.

Each agent owns a small set of intents and a bounded tool plan. Deterministic
first; an optional LLM polish is added by the tools only when enabled.
"""
import agent_platform
import agent_tools as T


class CandidateAgent:
    NAME = "career_coach"
    INTENTS = ["study_plan", "gap_explain", "practice_hint", "application_draft"]

    def run(self, intent, payload, ctx):
        if intent == "study_plan":
            artifact = agent_platform.call_tool(ctx, "draft_study_plan", T.draft_study_plan)
            return {
                "summary": "Drafted a week-by-week study plan from your weak topics.",
                "artifacts": [artifact],
                "data": {},
            }
        if intent == "gap_explain":
            artifact = agent_platform.call_tool(ctx, "draft_gap_explainer", T.draft_gap_explainer)
            return {
                "summary": "Compared verified and unverified skills and mapped the fastest path.",
                "artifacts": [artifact],
                "data": {},
            }
        if intent == "practice_hint":
            topic = payload.get("topic") or "sql"
            questions = agent_platform.call_tool(
                ctx, "practice_questions", T.practice_questions, topic, payload.get("count", 3)
            )
            return {
                "summary": (
                    f"Retrieved {questions.get('count', 0)} practice question(s) for {topic}. "
                    "Answers remain hidden."
                ),
                "artifacts": [],
                "data": {"practice": questions},
            }
        if intent == "application_draft":
            job_id = payload.get("job_id")
            if not job_id:
                raise ValueError("job_id_required")
            artifact = agent_platform.call_tool(
                ctx, "draft_application_answer", T.draft_application_answer, job_id
            )
            return {
                "summary": "Drafted an application note grounded in your verified skills.",
                "artifacts": [artifact],
                "data": {},
            }
        raise ValueError("unsupported_intent")


class CompanyAgent:
    NAME = "hiring_copilot"
    INTENTS = ["job_skills", "shortlist", "feedback_draft", "evidence_summary"]

    def run(self, intent, payload, ctx):
        if intent == "job_skills":
            description = payload.get("description") or payload.get("title") or ""
            artifact = agent_platform.call_tool(
                ctx, "draft_job_skills", T.draft_job_skills, description
            )
            return {
                "summary": "Mapped the job description to the closed skill taxonomy.",
                "artifacts": [artifact],
                "data": {},
            }
        if intent == "shortlist":
            artifact = agent_platform.call_tool(ctx, "draft_shortlist", T.draft_shortlist)
            return {
                "summary": "Built a consent-gated shortlist with evidence-based reasons.",
                "artifacts": [artifact],
                "data": {},
            }
        if intent == "feedback_draft":
            application_id = payload.get("application_id")
            if not application_id:
                raise ValueError("application_id_required")
            artifact = agent_platform.call_tool(
                ctx, "draft_feedback", T.draft_feedback, application_id
            )
            return {
                "summary": "Drafted candidate feedback for human review.",
                "artifacts": [artifact],
                "data": {},
            }
        if intent == "evidence_summary":
            artifact = agent_platform.call_tool(ctx, "draft_shortlist", T.draft_shortlist)
            return {
                "summary": "Summarised the consenting applicants' verified evidence.",
                "artifacts": [],
                "data": artifact["body"],
            }
        raise ValueError("unsupported_intent")


class AdminAgent:
    NAME = "governance_copilot"
    INTENTS = ["question_coverage", "question_draft", "integrity_summary"]

    def run(self, intent, payload, ctx):
        if intent == "question_coverage":
            coverage = agent_platform.call_tool(ctx, "skill_coverage", T.skill_coverage)
            return {
                "summary": (
                    f"{coverage.get('covered', 0)} skills covered, "
                    f"{coverage.get('pending', 0)} pending question-bank coverage."
                ),
                "artifacts": [],
                "data": coverage,
            }
        if intent == "question_draft":
            skill = payload.get("skill") or "sql"
            artifact = agent_platform.call_tool(
                ctx, "draft_questions", T.draft_questions, skill, payload.get("count", 3)
            )
            return {
                "summary": f"Drafted questions for {artifact['body'].get('skill', skill)} (pending approval).",
                "artifacts": [artifact],
                "data": {},
            }
        if intent == "integrity_summary":
            attempt_id = payload.get("attempt_id")
            if not attempt_id:
                raise ValueError("attempt_id_required")
            artifact = agent_platform.call_tool(
                ctx, "draft_integrity_summary", T.draft_integrity_summary, attempt_id
            )
            return {
                "summary": artifact["body"].get("headline", "Integrity summary drafted (advisory)."),
                "artifacts": [artifact],
                "data": {},
            }
        raise ValueError("unsupported_intent")


AGENTS = {
    "candidate": CandidateAgent(),
    "company": CompanyAgent(),
    "admin": AdminAgent(),
}


def intents_for(role: str) -> list:
    agent = AGENTS.get(role)
    return list(agent.INTENTS) if agent else []
