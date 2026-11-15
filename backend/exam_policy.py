"""Fixed-budget job-specific assessment policy.

This module is intentionally pure: it decides *which* approved questions make up
a 40-question exam, and how the sections are weighted. It never invents content
and never grades anything. Scoring stays in ``engine``/the stored answer key.

Budget (hard maximum, business rule):
    Fundamentals  20   50%
    CV clusters   16   40%
    Project probes 4   10%
    Total         40   40 minutes

The CS/IT fundamentals split lives in a config table per department
(``assessment_track_config``); only CS/IT is launched. Non-CS tracks are
prepared here but marked ``launched: False`` so they cannot be selected.
"""
from __future__ import annotations

import json
import re
from collections import Counter

import graphrag as G

TOTAL_QUESTIONS = 40
FUNDAMENTAL_QUESTIONS = 20
CV_QUESTIONS = 16
PROJECT_PROBES = 4
MIN_PER_CLUSTER = 3
MAX_PER_CLUSTER = 7
MAX_CODING_TASKS = 1
MAX_SQL_QUESTIONS = 2
# Job-mode time budget. The question bank's authoring time is not used here: a
# 40-question exam only fits 40 minutes when objective items get 45-90 seconds.
JOB_TIME_CAP_SECONDS = {
    "mcq": 45,
    "sql": 120,
    "coding": 300,
    "scenario": 60,
    "explanation": 60,
}

DEPARTMENT_TRACKS = {
    "CS/IT": {
        "department": "CS/IT",
        "launched": True,
        "fundamentals": {
            "DSA": 5,
            "Coding": 4,
            "Database": 3,
            "Networking": 2,
            "Operating Systems": 2,
            "Critical Thinking": 4,
        },
    },
    # Prepared but deliberately not launched. Quotas are product drafts for the
    # next phase, not approved assessment policy.
    "Business": {
        "department": "Business",
        "launched": False,
        "fundamentals": {
            "Data Interpretation": 4,
            "Critical Thinking": 5,
            "Communication": 3,
            "Spreadsheets": 3,
            "Business Fundamentals": 3,
            "Logical Reasoning": 2,
        },
    },
    "Electrical": {
        "department": "Electrical",
        "launched": False,
        "fundamentals": {
            "Circuits": 5,
            "Signals": 4,
            "Embedded Systems": 4,
            "Networking": 2,
            "Mathematics": 3,
            "Critical Thinking": 2,
        },
    },
}

DEPARTMENT_KEYWORDS = {
    "CS/IT": (
        "computer science", "cse", "software engineering", "information technology",
        "computer engineering", "bsc in cs", "b.sc in cs", "ict",
    ),
    "Electrical": ("electrical", "electronic", "eee", "telecommunication"),
    "Business": ("business", "accounting", "finance", "marketing", "economics", "bba", "mba", "management"),
}

FUNDAMENTAL_RULES = {
    "DSA": {
        "categories": {"CAT-02"},
        "terms": ("data structure", "algorithm", "complexity", "array", "tree", "graph", "sorting", "heap", "hash"),
    },
    "Coding": {
        "categories": {"CAT-03"},
        "terms": ("program", "function", "code", "coding", "programming", "debug", "output",
                  "implement", "syntax", "python", "complexity", "list", "dictionary", "pandas"),
    },
    "Database": {
        "categories": {"CAT-01", "CAT-08"},
        "terms": ("sql", "database", "dbms", "query", "join", "index", "transaction", "normalization", "primary key"),
    },
    "Networking": {
        "categories": {"CAT-08"},
        "terms": ("network", "tcp", "udp", "dns", "http", "osi", "subnet", "routing", "socket"),
    },
    "Operating Systems": {
        "categories": {"CAT-08", "CAT-13"},
        "terms": ("operating system", "process", "thread", "scheduling", "memory", "deadlock", "context switch", "kernel", "linux"),
    },
    "Critical Thinking": {
        "categories": {"CAT-06", "CAT-07"},
        "terms": ("scenario", "reasoning", "decision", "trade-off", "troubleshoot", "incident", "root cause", "evidence"),
    },
    # Non-CS placeholders so the config table is explicit rather than silently
    # falling back to CS questions.
    "Data Interpretation": {"categories": {"CAT-07"}, "terms": ("chart", "data interpretation", "trend", "table")},
    "Communication": {"categories": {"CAT-06"}, "terms": ("communicat", "stakeholder", "explain", "written")},
    "Spreadsheets": {"categories": set(), "terms": ("excel", "spreadsheet", "pivot", "formula")},
    "Business Fundamentals": {"categories": set(), "terms": ("business", "revenue", "customer", "market")},
    "Logical Reasoning": {"categories": {"CAT-07"}, "terms": ("logical", "sequence", "pattern", "reasoning")},
    "Circuits": {"categories": set(), "terms": ("circuit", "voltage", "current", "resistor")},
    "Signals": {"categories": set(), "terms": ("signal", "fourier", "frequency", "filter")},
    "Embedded Systems": {"categories": set(), "terms": ("embedded", "microcontroller", "firmware", "rtos")},
    "Mathematics": {"categories": {"CAT-07"}, "terms": ("math", "calculus", "algebra", "probability")},
}

CLUSTER_BY_SKILL = {
    "python": "Backend", "java": "Backend", "csharp": "Backend", "cpp": "Backend",
    "sql": "Backend", "mongodb": "Backend", "redis": "Backend", "neo4j": "Backend",
    "meilisearch": "Backend",
    "javascript": "Frontend", "html_css": "Frontend",
    "ai_ml": "Data/AI", "statistics": "Data/AI", "visualization": "Data/AI", "excel": "Data/AI",
    "docker": "DevOps/Cloud", "kubernetes": "DevOps/Cloud", "aws": "DevOps/Cloud",
    "azure": "DevOps/Cloud", "gcp": "DevOps/Cloud", "linux": "DevOps/Cloud", "git": "DevOps/Cloud",
}
CLUSTER_ORDER = ["Backend", "Frontend", "Data/AI", "DevOps/Cloud", "Mobile", "Security", "Testing"]
FUNDAMENTAL_SKILL_IDS = {"dsa", "networking", "os", "oop"}

DIFFICULTY_SEQUENCE = ("Medium", "Medium", "Easy", "Medium", "Hard", "Medium", "Easy", "Hard")


# --------------------------------------------------------------------------- config
def detect_department(education_text: str) -> str:
    """Detect the department from the CV education line. The UI must confirm it."""
    text = re.sub(r"\s+", " ", str(education_text or "")).lower()
    if not text:
        return ""
    for department, keywords in DEPARTMENT_KEYWORDS.items():
        if any(keyword in text for keyword in keywords):
            return department
    return ""


def load_track_configs() -> dict:
    """Read ``assessment_track_config`` when available, else the static defaults."""
    try:
        from main import allr  # local import keeps this module testable without a DB
        rows = allr("SELECT department,config,launched FROM assessment_track_config")
        if rows:
            return {
                row["department"]: {
                    **json.loads(row["config"] or "{}"),
                    "department": row["department"],
                    "launched": bool(row["launched"]),
                }
                for row in rows
            }
    except Exception:
        pass
    return {key: dict(value) for key, value in DEPARTMENT_TRACKS.items()}


def launched_department(department: str) -> bool:
    track = DEPARTMENT_TRACKS.get(department)
    return bool(track and track.get("launched"))


# --------------------------------------------------------------------------- evidence
def _profile_texts(profile: dict) -> tuple[list[str], list[str], list[str]]:
    projects = profile.get("projects") or []
    experience = profile.get("experience") or []
    skills = profile.get("skills") or []
    def flatten(items):
        out = []
        for item in items:
            if isinstance(item, dict):
                out.append(" ".join(str(v) for v in item.values() if isinstance(v, (str, int, float))))
            else:
                out.append(str(item))
        return [text for text in out if text.strip()]
    return flatten(projects), flatten(experience), flatten(skills)


def _mentions(text: str, aliases: list[str]) -> bool:
    lower = text.lower()
    for alias in aliases:
        alias = alias.lower()
        if any(ch in alias for ch in "+#."):
            if alias in lower:
                return True
        elif re.search(r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])", lower):
            return True
    return False


def skill_evidence(profile: dict, skill_id: str, job_skills: list[str] | None = None) -> dict:
    """Evidence strength for one skill.

    A skill described inside a project counts much more than a bare skills-list
    mention. Experience, recency and target-job relevance add weight. This is
    evidence strength for selection only; it is not a score and never verifies a
    candidate by itself.
    """
    aliases = [skill_id.replace("_", " ")] + list(G.SKILL_ALIASES.get(skill_id, []))
    projects, experience, skills = _profile_texts(profile)
    in_projects = any(_mentions(text, aliases) for text in projects)
    in_experience = any(_mentions(text, aliases) for text in experience)
    in_skills = any(_mentions(text, aliases) for text in skills)
    job_relevant = bool(job_skills) and skill_id in set(job_skills)
    score = (4 if in_projects else 0) + (2 if in_experience else 0) + (1 if in_skills else 0) + (2 if job_relevant else 0)
    if in_projects:
        confidence = "high"
    elif in_experience:
        confidence = "medium"
    elif in_skills:
        confidence = "low"
    else:
        confidence = "none"
    return {
        "skill_id": skill_id,
        "label": G.SKILL_LABELS.get(skill_id, skill_id.replace("_", " ").title()),
        "score": score,
        "in_project": in_projects,
        "in_experience": in_experience,
        "in_skills_list": in_skills,
        "job_relevant": job_relevant,
        "confidence": confidence,
    }


def cluster_weights(profile: dict, confirmed_skills: list[str], job_skills: list[str] | None = None) -> list[dict]:
    """Group confirmed skills into clusters and rank them for the CV section."""
    by_cluster: dict[str, list[dict]] = {}
    for skill_id in dict.fromkeys(confirmed_skills):
        cluster = CLUSTER_BY_SKILL.get(skill_id)
        if not cluster or skill_id in FUNDAMENTAL_SKILL_IDS:
            continue
        evidence = skill_evidence(profile, skill_id, job_skills)
        if not evidence["score"]:
            evidence["score"] = 1  # confirmed skills always remain eligible
        by_cluster.setdefault(cluster, []).append(evidence)
    ranked = []
    for cluster in CLUSTER_ORDER:
        skills = by_cluster.get(cluster) or []
        if not skills:
            continue
        skills.sort(key=lambda item: (-item["score"], item["skill_id"]))
        ranked.append({
            "cluster": cluster,
            "weight": sum(item["score"] for item in skills),
            "skills": skills,
            "anchors": [item["skill_id"] for item in skills[:3]],
            "confidence": "high" if sum(item["confidence"] == "high" for item in skills) >= 2 else
                          ("medium" if any(item["confidence"] in ("high", "medium") for item in skills) else "low"),
        })
    ranked.sort(key=lambda item: (-item["weight"], CLUSTER_ORDER.index(item["cluster"])))
    return ranked


def split_cluster_quota(total: int = CV_QUESTIONS, weights: list[int] | None = None) -> list[int]:
    """Split 16 questions across clusters with 3..7 per cluster."""
    count = len(weights or [])
    if not count:
        return []
    if count * MIN_PER_CLUSTER > total:
        raise ValueError("too many clusters for the minimum question budget")
    base = [MIN_PER_CLUSTER] * count
    remaining = total - sum(base)
    weights = weights or [1] * count
    weight_sum = float(sum(weights) or count)
    ideal = [remaining * (weight / weight_sum) for weight in weights]
    add = [int(value) for value in ideal]
    for index in range(remaining - sum(add)):
        add[index % count] += 1
    result = [base[i] + add[i] for i in range(count)]
    # Clamp above the max and redistribute the excess while capacity remains.
    excess = sum(max(0, value - MAX_PER_CLUSTER) for value in result)
    result = [min(value, MAX_PER_CLUSTER) for value in result]
    capacity = count * MAX_PER_CLUSTER - sum(result)
    excess = min(excess, max(0, capacity))
    while excess > 0:
        progressed = False
        for index in range(count):
            if result[index] < MAX_PER_CLUSTER and excess:
                result[index] += 1
                excess -= 1
                progressed = True
            if not excess:
                break
        if not progressed:
            break
    return result


# --------------------------------------------------------------------------- adaptive
def next_difficulty(current: str, correct: bool) -> str:
    """One-step adaptive ladder: harder after a correct answer, easier after a miss."""
    ladder = ["Easy", "Medium", "Hard"]
    index = ladder.index(current) if current in ladder else 1
    index = index + 1 if correct else index - 1
    return ladder[max(0, min(len(ladder) - 1, index))]


def should_stop(answers: list[dict], *, minimum: int = 20, maximum: int = TOTAL_QUESTIONS) -> bool:
    """Stop early when the current level is clear; never exceed the hard maximum."""
    if len(answers) >= maximum:
        return True
    if len(answers) < minimum:
        return False
    recent = answers[-6:]
    if len(recent) < 6:
        return False
    outcomes = {bool(item.get("correct")) for item in recent}
    return len(outcomes) == 1


# --------------------------------------------------------------------------- selection
def _match_topic(question: dict, topic: str) -> bool:
    rule = FUNDAMENTAL_RULES.get(topic)
    if not rule:
        return False
    if rule["categories"] and question.get("category_id") not in rule["categories"]:
        return False
    haystack = f"{question.get('subcategory', '')} {question.get('question_text', '')}".lower()
    return any(term in haystack for term in rule["terms"])


def _cycles(count: int) -> list[str]:
    return [DIFFICULTY_SEQUENCE[index % len(DIFFICULTY_SEQUENCE)] for index in range(count)]


def _pick(pool: list[dict], count: int, used: set[str], *, allow_coding: bool, sql_left: int,
          prefer_objective: bool = False) -> list[dict]:
    """Pick ``count`` questions, spreading difficulty and respecting format caps.

    Job-specific exams are budgeted at ~60s per question, so objective formats
    (MCQ / SQL) are preferred; descriptive items are only used when the bank has
    no objective question for that slot.
    """
    chosen: list[dict] = []
    for difficulty in _cycles(count):
        candidates = [
            q for q in pool
            if q["id"] not in used
            and G._difficulty(q) == difficulty
            and (allow_coding or G._format_kind(q) != "coding")
            and (sql_left > 0 or G._format_kind(q) != "sql")
        ]
        if not candidates:
            candidates = [
                q for q in pool
                if q["id"] not in used
                and (allow_coding or G._format_kind(q) != "coding")
                and (sql_left > 0 or G._format_kind(q) != "sql")
            ]
        if not candidates:
            break

        def rank(q):
            kind = G._format_kind(q)
            objective = 0 if kind in ("mcq", "sql") else 1
            return (
                (0 if not prefer_objective else objective),
                G._format_priority(kind),
                q["id"],
            )

        candidates.sort(key=rank)
        pick = candidates[0]
        if G._format_kind(pick) == "sql":
            sql_left -= 1
        used.add(pick["id"])
        chosen.append(pick)
    return chosen


def _cluster_pool(bank: list[dict], skills: list[str]) -> list[dict]:
    pool: dict[str, dict] = {}
    for skill_id in skills:
        skill = G.CVSkill(skill_id=skill_id, label=G.SKILL_LABELS.get(skill_id, skill_id))
        for question in bank:
            if G._skill_match(question, skill):
                pool[question["id"]] = question
    return list(pool.values())


def _project_text(project: dict) -> str:
    return " ".join(str(value) for value in (project or {}).values() if isinstance(value, (str, int, float)))


def _project_cluster(project: dict, clusters: list[dict]) -> str:
    text = _project_text(project)
    for cluster in clusters:
        for skill in cluster["skills"]:
            aliases = [skill["skill_id"].replace("_", " ")] + list(G.SKILL_ALIASES.get(skill["skill_id"], []))
            if _mentions(text, aliases):
                return cluster["cluster"]
    return clusters[0]["cluster"] if clusters else ""


def plan_job_exam(
    rows,
    profile: dict,
    *,
    department: str = "CS/IT",
    confirmed_skills: list[str] | None = None,
    job_skills: list[str] | None = None,
    requested_skill_ids: list[str] | None = None,
    track: dict | None = None,
) -> dict:
    """Build the 40-question job-specific blueprint from approved questions only.

    The selector fails closed: every unmet quota is reported in ``shortages`` and
    no question is fabricated. The returned list is immutable evidence for the
    attempt; the runtime can reorder it adaptively but never add questions beyond
    the hard maximum.
    """
    track = track or DEPARTMENT_TRACKS.get(department)
    if not track:
        raise ValueError(f"Unknown department track: {department}")
    if not track.get("launched"):
        raise ValueError(f"Department track {department} is not launched")

    bank = []
    for row in rows:
        data = dict(row)
        try:
            data["options"] = json.loads(data.get("options") or "[]") if isinstance(data.get("options"), str) else (data.get("options") or [])
            record = G.QuestionRecord.model_validate(data)
        except Exception:
            continue
        if record.status == "active" and record.question_text.strip():
            bank.append(record.model_dump())

    confirmed = list(dict.fromkeys(confirmed_skills or []))
    requested = [skill_id for skill_id in dict.fromkeys(requested_skill_ids or []) if skill_id in confirmed][:5]
    used: set[str] = set()
    shortages: list[dict] = []
    sql_left = MAX_SQL_QUESTIONS
    coding_used = 0
    selected: list[dict] = []

    # One (and only one) real coding task per exam.
    coding_pool = [q for q in bank if G._format_kind(q) == "coding"]
    if coding_pool:
        coding_pool.sort(key=lambda q: (G._difficulty(q) != "Medium", q["id"]))
        coding_question = coding_pool[0]
        used.add(coding_question["id"])
        coding_used = 1
        selected.append({
            **coding_question,
            "assessment_section": "fundamental",
            "assessment_topic": "Coding",
            "assessment_topic_key": "coding",
            "skill_id": None,
            "format_role": "coding_task",
        })
    else:
        shortages.append({"section": "fundamental", "topic": "Coding", "required": 1, "available": 0,
                          "reason": "no_coding_question"})

    # Fundamentals. The coding topic keeps its remaining quota in non-coding
    # formats (predict-the-output, find-the-bug style).
    for topic, target in track["fundamentals"].items():
        if topic == "Coding":
            target = max(0, target - coding_used)
        start = len(selected)
        pool = [q for q in bank if _match_topic(q, topic)]
        chosen = _pick(pool, target, used, allow_coding=False, sql_left=sql_left, prefer_objective=True)
        sql_left -= sum(1 for q in chosen if G._format_kind(q) == "sql")
        for question in chosen:
            selected.append({
                **question,
                "assessment_section": "fundamental",
                "assessment_topic": topic,
                "assessment_topic_key": re.sub(r"[^a-z0-9]+", "_", topic.lower()).strip("_"),
                "skill_id": None,
            })
        if len(selected) - start < target:
            shortages.append({"section": "fundamental", "topic": topic,
                              "required": target, "available": len(selected) - start})

    # CV clusters.
    clusters = cluster_weights(profile, confirmed, job_skills)
    # Candidate-picked skills move their cluster up without inventing new clusters.
    for cluster in clusters:
        cluster["picked"] = [skill for skill in cluster["anchors"] if skill in requested]
    # Keep only clusters that can actually fill the 3-question minimum; dropping
    # a thin cluster is better than shipping an exam with an unfillable quota.
    eligible = []
    for cluster in clusters:
        pool_ids = {
            q["id"] for q in _cluster_pool(bank, [skill["skill_id"] for skill in cluster["skills"]])
            if q["id"] not in used and G._format_kind(q) != "coding"
        }
        if len(pool_ids) >= MIN_PER_CLUSTER:
            eligible.append(cluster)
    clusters = eligible[:4]
    if len(clusters) < 3:
        shortages.append({"section": "cv", "topic": "clusters", "required": 3,
                          "available": len(clusters), "reason": "not_enough_confirmed_skills"})

    # Project probes are chosen before the CV section so a scenario needed for a
    # project is reserved rather than consumed by cluster sampling.
    projects = [item for item in (profile.get("projects") or []) if isinstance(item, dict) and _project_text(item).strip()]
    probes: list[dict] = []
    reserved: set[str] = set()
    for index, project in enumerate(projects[:PROJECT_PROBES]):
        cluster_name = _project_cluster(project, clusters)
        cluster = next((item for item in clusters if item["cluster"] == cluster_name), None)
        pool = _cluster_pool(bank, [skill["skill_id"] for skill in (cluster or {"skills": []})["skills"]])
        scenarios = [
            q for q in pool
            if q["id"] not in used and q["id"] not in reserved
            and G._format_kind(q) in ("scenario", "explanation")
        ]
        scenarios.sort(key=lambda q: (G._difficulty(q) != "Hard", G._format_priority(G._format_kind(q)), q["id"]))
        if not scenarios:
            # Fallback: a hard question about the same technology. It still has a
            # stored answer key; only the open-ended scenario prose is missing.
            fallback = [
                q for q in pool
                if q["id"] not in used and q["id"] not in reserved
                and G._difficulty(q) == "Hard"
                and G._format_kind(q) not in ("coding", "sql")
            ]
            fallback.sort(key=lambda q: q["id"])
            scenarios = fallback
        if not scenarios:
            shortages.append({"section": "project", "topic": _project_text(project)[:80],
                              "required": 1, "available": 0, "reason": "no_project_scenario"})
            continue
        question = scenarios[0]
        reserved.add(question["id"])
        project_name = str(project.get("name") or project.get("title") or f"Project {index + 1}").strip()
        probes.append({
            **question,
            "question_text": f'Project "{project_name}": {question["question_text"]}',
            "assessment_section": "project",
            "assessment_topic": "Project probes",
            "assessment_topic_key": "project_probes",
            "skill_id": (cluster or {}).get("anchors", [None])[0] if cluster else None,
            "project_name": project_name,
            "probe_source": "project",
            "cluster": cluster_name,
        })

    quotas = split_cluster_quota(CV_QUESTIONS, [cluster["weight"] for cluster in clusters]) if clusters else []
    cv_used = set(used) | reserved
    for cluster, quota in zip(clusters, quotas):
        pool = _cluster_pool(bank, [skill["skill_id"] for skill in cluster["skills"]])
        chosen = _pick(pool, quota, cv_used, allow_coding=False, sql_left=sql_left, prefer_objective=True)
        sql_left -= sum(1 for q in chosen if G._format_kind(q) == "sql")
        for question in chosen:
            # Test 2-3 anchor skills per cluster; never claim a skill the
            # question text does not actually match.
            matched = [skill["skill_id"] for skill in cluster["skills"]
                       if G._skill_match(question, G.CVSkill(skill_id=skill["skill_id"],
                                                             label=skill["label"]))]
            selected.append({
                **question,
                "assessment_section": "cv",
                "assessment_topic": cluster["cluster"],
                "assessment_topic_key": re.sub(r"[^a-z0-9]+", "_", cluster["cluster"].lower()).strip("_"),
                "skill_id": matched[0] if matched else None,
                "cluster": cluster["cluster"],
                "anchor_skills": matched[:3],
            })
        if len(chosen) < quota:
            shortages.append({"section": "cv", "topic": cluster["cluster"],
                              "required": quota, "available": len(chosen),
                              "reason": "question_bank_coverage"})
    used |= cv_used

    if len(probes) < PROJECT_PROBES:
        # Candidates without (enough) projects still get scenario probes drawn
        # from the same clusters. They are labelled as scenario probes, never
        # presented as the candidate's own project.
        for cluster in clusters:
            if len(probes) >= PROJECT_PROBES:
                break
            pool = _cluster_pool(bank, [skill["skill_id"] for skill in cluster["skills"]])
            scenarios = [
                q for q in pool
                if q["id"] not in used and q["id"] not in reserved
                and G._format_kind(q) in ("scenario", "explanation")
            ]
            scenarios.sort(key=lambda q: (G._difficulty(q) != "Hard", q["id"]))
            for question in scenarios:
                if len(probes) >= PROJECT_PROBES:
                    break
                reserved.add(question["id"])
                probes.append({
                    **question,
                    "assessment_section": "project",
                    "assessment_topic": "Project probes",
                    "assessment_topic_key": "project_probes",
                    "skill_id": cluster["anchors"][0] if cluster["anchors"] else None,
                    "project_name": "",
                    "probe_source": "scenario_fallback",
                    "cluster": cluster["cluster"],
                })
    if len(probes) < PROJECT_PROBES:
        shortages.append({"section": "project", "topic": "project probes",
                          "required": PROJECT_PROBES, "available": len(probes),
                          "reason": "not_enough_projects_or_scenarios"})

    selected.extend(probes)
    fundamentals = [q for q in selected if q["assessment_section"] == "fundamental"]
    cv = [q for q in selected if q["assessment_section"] == "cv"]
    # Serve fundamentals in the department's topic order (coding task inside the
    # Coding block, not as an accidental question 1), then clusters, then projects.
    ordered_fundamentals: list[dict] = []
    for topic in track["fundamentals"]:
        ordered_fundamentals.extend(q for q in fundamentals if q["assessment_topic"] == topic)
    ordered_fundamentals.extend(q for q in fundamentals if q["id"] not in {item["id"] for item in ordered_fundamentals})
    fundamentals = ordered_fundamentals
    selected = fundamentals + cv + probes
    authoring_seconds = sum(int(q.get("time_allocation") or 60) for q in selected)
    planned_seconds = sum(JOB_TIME_CAP_SECONDS.get(G._format_kind(q), 60) for q in selected)

    return {
        "status": "ready" if len(selected) == TOTAL_QUESTIONS else "question_bank_incomplete",
        "department": department,
        "total_questions": len(selected),
        "hard_maximum": TOTAL_QUESTIONS,
        "duration_minutes": 40,
        "time_budget_seconds": 40 * 60,
        "estimated_duration_seconds": planned_seconds,
        "authoring_duration_seconds": authoring_seconds,
        "over_time_budget": planned_seconds > 40 * 60,
        "fundamental": fundamentals,
        "cv_based": cv,
        "project_probes": probes,
        "questions": selected,
        "sections": {
            "fundamentals": len(fundamentals),
            "cv_clusters": len(cv),
            "project_probes": len(probes),
        },
        "coding_tasks": sum(1 for q in selected if G._format_kind(q) == "coding"),
        "sql_questions": sum(1 for q in selected if G._format_kind(q) == "sql"),
        "clusters": [
            {
                "cluster": cluster["cluster"],
                "quota": quota,
                "weight": cluster["weight"],
                "confidence": cluster["confidence"],
                "anchor_skills": cluster["anchors"],
                "candidate_picked": cluster["picked"],
            }
            for cluster, quota in zip(clusters, quotas)
        ],
        "requested_skill_ids": requested,
        "skill_evidence": [skill_evidence(profile, skill_id, job_skills)
                           for skill_id in confirmed if skill_id in G.SKILL_LABELS],
        "shortages": shortages,
    }


def cluster_report(questions: list[dict], results: list[dict]) -> list[dict]:
    """Cluster-level results with confidence. Fundamentals and clusters stay separate."""
    by_question = {str(item.get("question_id")): item for item in results}
    buckets: dict[str, list[dict]] = {}
    for question in questions:
        cluster = question.get("cluster") or (
            (question.get("assessment_topic") if question.get("assessment_section") == "cv" else None)
        )
        if not cluster:
            continue
        result = by_question.get(str(question.get("id"))) or {}
        buckets.setdefault(cluster, []).append(result)
    report = []
    for cluster, rows in buckets.items():
        objective = [row for row in rows if row.get("awarded_marks") is not None]
        total = sum(float(row.get("max_marks") or 0) for row in objective)
        awarded = sum(float(row.get("awarded_marks") or 0) for row in objective)
        pct = round(100 * awarded / total) if total else None
        level = ("Advanced" if pct is not None and pct >= 80 else
                 "Intermediate" if pct is not None and pct >= 55 else
                 "Foundation" if pct is not None else "Pending human review")
        answered = len(rows)
        confidence = "high" if answered >= 5 else ("medium" if answered >= 3 else "low")
        report.append({
            "cluster": cluster,
            "level": level,
            "percent": pct,
            "confidence": confidence,
            "questions": answered,
            "note": "Fundamentals are reported separately and are not averaged into cluster levels.",
        })
    return report
