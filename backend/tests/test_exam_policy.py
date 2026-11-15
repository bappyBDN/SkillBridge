"""Tests for the fixed-budget job-specific exam policy.

Pure selection logic only: the fixtures are synthetic question rows, so these
tests do not touch the database or the live question bank.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import exam_policy as P


def row(qid, category_id, subcategory, qtype, difficulty, text, marks=1, seconds=60):
    return {
        "id": qid,
        "category_id": category_id,
        "subcategory": subcategory,
        "question_type": qtype,
        "difficulty_level": difficulty,
        "question_text": text,
        "options": ["Option A", "Option B", "Option C", "Option D"],
        "correct_answer": "Option A",
        "explanation": "Explanation",
        "reference_answer": "",
        "grading_rubric": "",
        "marks": marks,
        "time_allocation": seconds,
        "status": "active",
        "created_by": "test",
        "created_at": 0,
        "version": 1,
    }


def build_bank():
    levels = ("Easy", "Medium", "Hard")
    rows = []

    def fill(prefix, category, subcategory, qtype, text, count=9):
        for index in range(count):
            rows.append(row(
                f"{prefix}-{index}", category, subcategory, qtype,
                levels[index % 3], f"{text} (variation {index})",
            ))

    # DSA
    fill("DSA", "CAT-02", "Arrays & Strings", "MCQ", "data structure algorithm complexity array")
    # Coding: exactly one real coding task is selected by the planner.
    for index, difficulty in enumerate(levels):
        rows.append(row(f"COD-{index}", "CAT-03", "Python", "Coding", difficulty,
                        f"Write a function to solve coding problem {index}"))
    fill("CODE-READ", "CAT-03", "Python", "MCQ", "What is the output of this code?")
    # Database (includes one SQL type to prove the cap)
    fill("DB", "CAT-01", "Joins", "MCQ", "SQL join query index plan")
    rows.append(row("SQL-1", "CAT-01", "Joins", "SQL", "Medium", "SQL query to join customers and orders"))
    # Networking
    fill("NET", "CAT-08", "Computer Networks", "MCQ", "TCP DNS network routing")
    # Operating systems
    fill("OS", "CAT-13", "Operating Systems", "MCQ", "operating system process context switch memory")
    # Critical thinking
    fill("CT", "CAT-06", "Case Study", "Scenario-Based", "incident scenario root cause evidence decision")
    # Clusters
    fill("BE", "CAT-11", "FastAPI", "MCQ", "FastAPI dependency injection request lifecycle")
    rows.append(row("BE-EXP", "CAT-11", "FastAPI", "Explainable", "Medium",
                    "Explain how FastAPI dependency injection works under the hood"))
    rows.append(row("BE-SCN", "CAT-11", "FastAPI", "Scenario-Based", "Hard",
                    "Scenario: your FastAPI API gets 10x traffic. What breaks first?"))
    fill("FE", "CAT-12", "React & Next.js", "MCQ", "React component state props rendering")
    fill("AI", "CAT-04", "RAG Pipelines", "MCQ", "RAG retrieval embeddings vector search")
    fill("OPS", "CAT-13", "Docker", "MCQ", "Docker image layers multi-stage build")
    return rows


def profile():
    return {
        "skills": [{"name": "FastAPI"}, {"name": "React"}, {"name": "RAG"}, {"name": "Docker"}],
        "experience": [{"title": "Backend intern", "description": "FastAPI endpoints and PostgreSQL queries"}],
        "projects": [
            {"name": "Shop API", "description": "FastAPI service with PostgreSQL and Docker"},
            {"name": "Dashboard", "description": "React dashboard with charts"},
            {"name": "Support bot", "description": "RAG pipeline with embeddings"},
            {"name": "Deploy kit", "description": "Docker images and CI deployment"},
        ],
        "summary": "",
    }


def test_department_detection():
    assert P.detect_department("BSc in Computer Science and Engineering") == "CS/IT"
    assert P.detect_department("BSc in Electrical and Electronic Engineering") == "Electrical"
    assert P.detect_department("BBA in Finance") == "Business"
    assert P.detect_department("") == ""


def test_only_launched_departments_can_be_planned():
    assert P.launched_department("CS/IT")
    assert not P.launched_department("Business")
    try:
        P.plan_job_exam(build_bank(), profile(), department="Business",
                        confirmed_skills=["python"])
    except ValueError as exc:
        assert "not launched" in str(exc)
    else:
        raise AssertionError("Business track must not be launchable")


def test_cluster_quota_is_bounded_and_sums_to_sixteen():
    quotas = P.split_cluster_quota(16, [10, 8, 6, 4])
    assert sum(quotas) == 16
    assert all(3 <= value <= 7 for value in quotas)
    assert sum(P.split_cluster_quota(16, [5, 4, 3])) == 16


def test_adaptive_helpers():
    assert P.next_difficulty("Medium", True) == "Hard"
    assert P.next_difficulty("Medium", False) == "Easy"
    assert P.next_difficulty("Easy", False) == "Easy"
    assert P.next_difficulty("Hard", True) == "Hard"
    assert not P.should_stop([{"correct": True}] * 10)
    assert P.should_stop([{"correct": True}] * 20)
    assert not P.should_stop([{"correct": True}, {"correct": False}] * 10)
    assert P.should_stop([{"correct": False}] * 40)


def test_job_exam_budget_and_format_caps():
    result = P.plan_job_exam(
        build_bank(), profile(), department="CS/IT",
        confirmed_skills=["python", "javascript", "ai_ml", "docker"],
        job_skills=["python", "javascript"],
        requested_skill_ids=["python"],
    )
    assert result["status"] == "ready", result["shortages"]
    assert result["total_questions"] == 40
    assert result["sections"] == {"fundamentals": 20, "cv_clusters": 16, "project_probes": 4}
    assert result["coding_tasks"] == 1
    assert result["sql_questions"] <= P.MAX_SQL_QUESTIONS
    assert len({q["id"] for q in result["questions"]}) == 40
    assert all(q.get("assessment_section") in ("fundamental", "cv", "project") for q in result["questions"])
    quotas = [cluster["quota"] for cluster in result["clusters"]]
    assert len(quotas) == 4 and sum(quotas) == 16
    assert all(P.MIN_PER_CLUSTER <= quota <= P.MAX_PER_CLUSTER for quota in quotas)
    # One coding task, and it is a real Coding question.
    coding = [q for q in result["questions"] if q["question_type"] == "Coding"]
    assert len(coding) == 1
    # Project probes are labelled and carry the candidate's project name.
    probes = result["project_probes"]
    assert len(probes) == 4
    assert all(q["question_text"].startswith('Project "') for q in probes)
    # Cluster report keeps fundamentals separate.
    report = P.cluster_report(result["questions"], [])
    assert report and all("Fundamentals are reported separately" in item["note"] for item in report)


def test_shortages_are_reported_instead_of_fabricating_questions():
    tiny = [row("ONE", "CAT-02", "Arrays & Strings", "MCQ", "Easy", "data structure")]
    result = P.plan_job_exam(tiny, profile(), department="CS/IT", confirmed_skills=["python"])
    assert result["status"] == "question_bank_incomplete"
    assert result["total_questions"] < 40
    assert result["shortages"]
