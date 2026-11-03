"""GraphRAG assessment retrieval.

Question content is authored/approved in the existing question_bank. This module only
retrieves and assembles approved questions; it never invents answers or grades candidates.
Meilisearch and Neo4j are optional accelerators. The relational question bank remains the
source of truth and provides a deterministic fallback when either service is unavailable.
"""
from __future__ import annotations

import json
import logging
import os
import re
import time
from collections import defaultdict
from typing import Any, Iterable

from pydantic import BaseModel, Field, ValidationError

log = logging.getLogger("skillbridge.graphrag")

# Largest-remainder rounding for 25 questions: 10/8/7 is the closest integer split.
DIFFICULTY_TARGETS = {"Easy": 10, "Medium": 8, "Hard": 7}
FUNDAMENTAL_TARGETS = {
    "DSA": 5, "OOP": 4, "Networking": 4,
    "Coding": 5, "Database": 5, "Critical Thinking": 2,
}
FUNDAMENTAL_TOTAL = 25
# Per-topic quotas sum exactly to 25 and roll up to 10 Easy / 8 Medium / 7 Hard.
FUNDAMENTAL_DIFFICULTY_MATRIX = {
    "DSA": {"Easy": 2, "Medium": 2, "Hard": 1},
    "OOP": {"Easy": 2, "Medium": 1, "Hard": 1},
    "Networking": {"Easy": 2, "Medium": 1, "Hard": 1},
    "Coding": {"Easy": 2, "Medium": 2, "Hard": 1},
    "Database": {"Easy": 2, "Medium": 1, "Hard": 2},
    "Critical Thinking": {"Easy": 0, "Medium": 1, "Hard": 1},
}
PER_SKILL_TARGETS = {"Easy": 1, "Medium": 2, "Hard": 2}
QUESTION_PAGE_SIZE = 5

SKILL_ALIASES = {
    "python": ["python", "pandas", "numpy", "fastapi", "django", "flask"],
    "git": ["git", "github", "gitlab", "bitbucket"],
    "ai_ml": ["ai", "artificial intelligence", "machine learning", "ml", "deep learning", "tensorflow", "pytorch", "scikit-learn", "sklearn"],
    "sql": ["sql", "mysql", "postgresql", "postgres", "sqlite", "sql server"],
    "javascript": ["javascript", "typescript", "react", "node.js", "nodejs", "next.js"],
    "java": ["java", "spring boot"],
    "cpp": ["c++", "cpp"],
    "csharp": ["c#", "c sharp", ".net"],
    "docker": ["docker", "docker compose"],
    "kubernetes": ["kubernetes", "k8s"],
    "aws": ["aws", "amazon web services"],
    "azure": ["azure"],
    "gcp": ["gcp", "google cloud"],
    "mongodb": ["mongodb", "mongo"],
    "redis": ["redis"],
    "neo4j": ["neo4j", "cypher"],
    "meilisearch": ["meilisearch"],
    "html_css": ["html", "css", "tailwind", "bootstrap"],
    "linux": ["linux", "bash", "shell scripting"],
    "networking": ["computer networks", "networking", "tcp/ip", "dns", "http", "https"],
}

FUNDAMENTAL_CATEGORY_MAP = {
    "DSA": {"category_ids": {"CAT-02"}, "terms": ("dsa", "data structure", "algorithm", "complexity", "array", "tree", "graph", "sorting")},
    "OOP": {"category_ids": {"CAT-05", "CAT-08", "CAT-03"}, "terms": ("oop", "object oriented", "class", "inheritance", "polymorphism", "encapsulation", "abstraction")},
    "Networking": {"category_ids": {"CAT-08"}, "terms": ("network", "tcp", "udp", "dns", "http", "osi", "subnet", "routing")},
    "Coding": {"category_ids": {"CAT-03"}, "terms": ("coding", "programming", "python", "function", "debug", "code", "implementation")},
    "Database": {"category_ids": {"CAT-01", "CAT-08"}, "terms": ("database", "sql", "dbms", "query", "join", "index", "transaction", "normalization")},
    "Critical Thinking": {"category_ids": {"CAT-06", "CAT-07"}, "terms": ("critical thinking", "scenario", "reasoning", "trade-off", "decision", "troubleshoot", "case study")},
}

class CVSkill(BaseModel):
    skill_id: str
    label: str
    evidence: str = Field(default="", max_length=500)
    confidence: float = Field(ge=0, le=1, default=0.8)
    source: str = "cv"

class QuestionRecord(BaseModel):
    id: str
    category_id: str
    subcategory: str = ""
    question_type: str
    difficulty_level: str
    question_text: str
    options: list[str] = Field(default_factory=list)
    correct_answer: str = ""
    explanation: str = ""
    reference_answer: str = ""
    grading_rubric: str = ""
    marks: int = 1
    time_allocation: int = 60
    status: str = "active"
    version: int = 1

class RetrievalTrace(BaseModel):
    question_id: str
    section: str
    topic: str
    difficulty: str
    keyword_rank: int | None = None
    graph_rank: int | None = None
    selected_rank: int
    reasons: list[str] = Field(default_factory=list)

def _spacy_terms(text: str) -> set[str]:
    """Use spaCy when a model is installed; regex aliases remain the deterministic fallback."""
    try:
        import spacy
        model = os.getenv("SPACY_MODEL", "en_core_web_sm")
        try:
            nlp = spacy.load(model, disable=["ner", "parser", "lemmatizer"])
        except OSError:
            nlp = spacy.blank("en")
        doc = nlp(text[:30000])
        return {token.text.lower() for token in doc if token.is_alpha or token.text in {"c++", "c#"}}
    except Exception as exc:
        log.info("spaCy unavailable; using alias matcher (%s)", type(exc).__name__)
        return set(re.findall(r"[a-zA-Z][a-zA-Z0-9+#.-]*", text.lower()))

def extract_cv_skills(redacted_cv: str) -> list[CVSkill]:
    """Extract explicit technology mentions only; no inference from job title or seniority."""
    text = (redacted_cv or "")[:30000]
    tokens = _spacy_terms(text)
    lower = text.lower()
    found: list[CVSkill] = []
    for skill_id, aliases in SKILL_ALIASES.items():
        matches = [alias for alias in aliases if re.search(r"(?<![a-z0-9])" + re.escape(alias) + r"(?![a-z0-9])", lower)]
        if not matches:
            continue
        alias = max(matches, key=len)
        pos = lower.find(alias)
        evidence = " ".join(text[max(0, pos-90):min(len(text), pos+len(alias)+110)].split())
        confidence = 0.95 if any(re.search(r"\b" + re.escape(a) + r"\b", lower) for a in matches) else 0.75
        found.append(CVSkill(skill_id=skill_id, label=skill_id.replace("_", " ").title(), evidence=evidence, confidence=confidence))
    return found

def _record(row: Any) -> dict:
    data = dict(row)
    for key in ("options",):
        if isinstance(data.get(key), str):
            try: data[key] = json.loads(data[key] or "[]")
            except Exception: data[key] = []
    return data

def _norm(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (value or "").lower()).strip()

def _difficulty(q: dict) -> str:
    value = str(q.get("difficulty_level", "")).strip().lower()
    return {"easy": "Easy", "medium": "Medium", "moderate": "Medium", "hard": "Hard"}.get(value, value.title())

def _topic_match(q: dict, topic: str) -> bool:
    spec = FUNDAMENTAL_CATEGORY_MAP[topic]
    if q.get("category_id") not in spec["category_ids"]:
        return False
    haystack = _norm(" ".join([str(q.get("subcategory", "")), str(q.get("question_text", ""))]))
    return any(_norm(term) in haystack for term in spec["terms"])

def _skill_match(q: dict, skill: CVSkill) -> bool:
    haystack = _norm(" ".join([str(q.get("subcategory", "")), str(q.get("question_text", "")), str(q.get("grading_rubric", ""))]))
    aliases = SKILL_ALIASES.get(skill.skill_id, [skill.label.lower()])
    return any(_norm(alias) in haystack for alias in aliases) or _norm(skill.label) in haystack

def _external_retrieval(query: str, category_id: str | None = None) -> tuple[list[str], list[str]]:
    """Return IDs ordered by Meilisearch and Neo4j. Missing services are a normal fallback."""
    keyword_ids: list[str] = []
    graph_ids: list[str] = []
    meili_url, meili_key = os.getenv("MEILISEARCH_URL", "").rstrip("/"), os.getenv("MEILISEARCH_API_KEY", "")
    if meili_url:
        try:
            import meilisearch
            client = meilisearch.Client(meili_url, meili_key or None)
            index = client.index(os.getenv("MEILISEARCH_QUESTION_INDEX", "skillbridge_questions"))
            params = {"limit": 80}
            if category_id:
                params["filter"] = f'category_id = "{category_id}"'
            result = index.search(query, params)
            keyword_ids = [str(x["id"]) for x in result.get("hits", []) if x.get("id")]
        except Exception as exc:
            log.warning("Meilisearch retrieval fallback: %s", type(exc).__name__)
    neo_uri, neo_user, neo_password = (os.getenv("NEO4J_URI", ""), os.getenv("NEO4J_USERNAME", "neo4j"), os.getenv("NEO4J_PASSWORD", ""))
    if neo_uri:
        try:
            from neo4j import GraphDatabase
            with GraphDatabase.driver(neo_uri, auth=(neo_user, neo_password)) as driver:
                records = driver.execute_query(
                    "MATCH p=(s:Skill)-[:RELATED_TO*0..2]-(t:Topic)-[:HAS_QUESTION]-(q:Question) "
                    "WHERE toLower(s.name) CONTAINS toLower($query) "
                    "RETURN q.id AS id, length(p) AS hops ORDER BY hops ASC LIMIT 80",
                    query=query, database_=os.getenv("NEO4J_DATABASE", "neo4j")
                ).records
                graph_ids = [str(r["id"]) for r in records if r.get("id")]
        except Exception as exc:
            log.warning("Neo4j retrieval fallback: %s", type(exc).__name__)
    return keyword_ids, graph_ids

def index_question_bank(rows: Iterable[Any]) -> dict:
    """Upsert approved question metadata into Meilisearch and Neo4j."""
    docs, graph_count = [], 0
    for row in rows:
        q = _record(row)
        if q.get("status") != "active":
            continue
        text = " ".join([str(q.get("question_text", "")), str(q.get("subcategory", "")), str(q.get("grading_rubric", ""))])
        topics = [name for name in FUNDAMENTAL_TARGETS if _topic_match(q, name)]
        skills = [sid for sid, aliases in SKILL_ALIASES.items()
                  if any(_norm(alias) in _norm(text) for alias in aliases)]
        docs.append({"id": str(q["id"]), "category_id": q.get("category_id", ""),
            "subcategory": q.get("subcategory", ""), "question_text": q.get("question_text", ""),
            "difficulty_level": _difficulty(q), "question_type": q.get("question_type", ""),
            "search_text": text, "topics": topics, "skills": skills, "status": "active",
            "version": int(q.get("version") or 1)})
    meili_result = "not_configured"
    meili_url, meili_key = os.getenv("MEILISEARCH_URL", "").rstrip("/"), os.getenv("MEILISEARCH_API_KEY", "")
    if meili_url:
        try:
            import meilisearch
            client = meilisearch.Client(meili_url, meili_key or None)
            index = client.index(os.getenv("MEILISEARCH_QUESTION_INDEX", "skillbridge_questions"))
            index.update_filterable_attributes(["category_id", "difficulty_level", "topics", "skills", "status"])
            index.add_documents(docs, primary_key="id")
            meili_result = "indexed"
        except Exception as exc:
            meili_result = "error:" + type(exc).__name__
            log.warning("Meilisearch indexing failed: %s", type(exc).__name__)
    neo_result = "not_configured"
    neo_uri = os.getenv("NEO4J_URI", "")
    if neo_uri:
        try:
            from neo4j import GraphDatabase
            with GraphDatabase.driver(neo_uri, auth=(os.getenv("NEO4J_USERNAME", "neo4j"), os.getenv("NEO4J_PASSWORD", ""))) as driver:
                with driver.session(database=os.getenv("NEO4J_DATABASE", "neo4j")) as session:
                    for doc in docs:
                        session.run("MERGE (q:Question {id:$id}) SET q.text=$text, q.category_id=$category, q.difficulty=$difficulty, q.status='active', q.version=$version",
                            id=doc["id"], text=doc["question_text"], category=doc["category_id"],
                            difficulty=doc["difficulty_level"], version=doc["version"])
                        for topic in doc["topics"]:
                            session.run("MERGE (t:Topic {name:$topic}) MERGE (q:Question {id:$id}) MERGE (t)-[:HAS_QUESTION]->(q)",
                                topic=topic, id=doc["id"])
                        for skill in doc["skills"]:
                            session.run("MERGE (s:Skill {name:$skill}) MERGE (q:Question {id:$id}) MERGE (s)-[:HAS_QUESTION]->(q)",
                                skill=skill, id=doc["id"])
                            related = {
                                "python": ["Coding", "DSA"], "javascript": ["Coding", "DSA"],
                                "java": ["Coding", "OOP"], "ai_ml": ["Coding", "DSA"],
                                "sql": ["Database"], "networking": ["Networking"],
                                "dsa": ["DSA"], "oop": ["OOP"],
                                "git": ["Coding"], "docker": ["Coding"],
                            }.get(skill, [])
                            for topic in related:
                                session.run("MERGE (s:Skill {name:$skill}) MERGE (t:Topic {name:$topic}) MERGE (s)-[:RELATED_TO]->(t)",
                                    skill=skill, topic=topic)
                    neo_result = "indexed"
                    graph_count = len(docs)
        except Exception as exc:
            neo_result = "error:" + type(exc).__name__
            log.warning("Neo4j indexing failed: %s", type(exc).__name__)
    return {"active_questions": len(docs), "meilisearch": meili_result, "neo4j": neo_result, "graph_questions": graph_count}

def _rrf_order(keyword_ids: Iterable[str], graph_ids: Iterable[str]) -> dict[str, float]:
    scores: dict[str, float] = defaultdict(float)
    for rank, qid in enumerate(keyword_ids, 1): scores[qid] += 1 / (60 + rank)
    for rank, qid in enumerate(graph_ids, 1): scores[qid] += 1 / (60 + rank)
    return scores

def _allocate(pool: list[dict], count: int, difficulty: str, used: set[str], external: dict[str, float]) -> list[dict]:
    candidates = [q for q in pool if q["id"] not in used and _difficulty(q) == difficulty]
    candidates.sort(key=lambda q: (-(external.get(q["id"], 0)), q["id"]))
    selected = candidates[:count]
    used.update(q["id"] for q in selected)
    return selected

def build_assessment(rows: Iterable[Any], cv_skills: list[CVSkill], *, retrieval: bool = True) -> dict:
    """Build the fixed fundamental section plus five questions per CV skill.

    The selector fails closed with detailed pool shortages; it never silently changes
    quotas or invents questions. All question IDs remain traceable to the source bank.
    """
    started = time.perf_counter()
    bank = []
    for row in rows:
        try:
            q = QuestionRecord.model_validate(_record(row))
            if q.status == "active" and q.question_text.strip():
                bank.append(q.model_dump())
        except (ValidationError, TypeError, ValueError):
            continue
    used: set[str] = set()
    selected: list[dict] = []
    trace: list[RetrievalTrace] = []
    shortages: list[dict] = []

    # One dual-retrieval pass per fundamental topic.
    for topic, target in FUNDAMENTAL_TARGETS.items():
        spec = FUNDAMENTAL_CATEGORY_MAP[topic]
        pool = [q for q in bank if _topic_match(q, topic)]
        keyword_ids, graph_ids = _external_retrieval(topic) if retrieval else ([], [])
        external = _rrf_order(keyword_ids, graph_ids)
        for difficulty, count in FUNDAMENTAL_DIFFICULTY_MATRIX[topic].items():
            chosen = _allocate(pool, count, difficulty, used, external)
            for q in chosen:
                selected.append({**q, "assessment_section": "fundamental", "assessment_topic": topic, "skill_id": None})
                trace.append(RetrievalTrace(question_id=q["id"], section="fundamental", topic=topic, difficulty=difficulty,
                    keyword_rank=(keyword_ids.index(q["id"])+1 if q["id"] in keyword_ids else None),
                    graph_rank=(graph_ids.index(q["id"])+1 if q["id"] in graph_ids else None),
                    selected_rank=len(selected), reasons=["approved_question_bank", "topic_match", "difficulty_quota"]))
            if len(chosen) < count:
                shortages.append({"section": "fundamental", "topic": topic, "difficulty": difficulty,
                                  "required": count, "available_selected": len(chosen)})
    # CV skills are explicit mentions and should be confirmed by the candidate in the UI.
    for skill in cv_skills:
        pool = [q for q in bank if _skill_match(q, skill)]
        keyword_ids, graph_ids = _external_retrieval(skill.label) if retrieval else ([], [])
        external = _rrf_order(keyword_ids, graph_ids)
        for difficulty, count in PER_SKILL_TARGETS.items():
            chosen = _allocate(pool, count, difficulty, used, external)
            for q in chosen:
                selected.append({**q, "assessment_section": "cv", "assessment_topic": skill.label, "skill_id": skill.skill_id})
                trace.append(RetrievalTrace(question_id=q["id"], section="cv", topic=skill.label, difficulty=difficulty,
                    keyword_rank=(keyword_ids.index(q["id"])+1 if q["id"] in keyword_ids else None),
                    graph_rank=(graph_ids.index(q["id"])+1 if q["id"] in graph_ids else None),
                    selected_rank=len(selected), reasons=["approved_question_bank", "explicit_cv_skill_match", "difficulty_quota"]))
            if len(chosen) < count:
                shortages.append({"section": "cv", "topic": skill.label, "difficulty": difficulty,
                                  "required": count, "available_selected": len(chosen)})
    elapsed_ms = round((time.perf_counter() - started) * 1000, 2)
    fundamental = [q for q in selected if q["assessment_section"] == "fundamental"]
    cv_questions = [q for q in selected if q["assessment_section"] == "cv"]
    total_seconds = sum(int(q.get("time_allocation") or 60) for q in selected)
    return {
        "status": "ready" if not shortages else "question_bank_incomplete",
        "fundamental": fundamental, "cv_based": cv_questions,
        "questions": selected, "total_questions": len(selected),
        "fundamental_count": len(fundamental), "cv_count": len(cv_questions),
        "estimated_duration_seconds": total_seconds,
        "estimated_duration_minutes": round(total_seconds / 60, 1),
        "difficulty_targets": DIFFICULTY_TARGETS,
        "fundamental_difficulty_matrix": FUNDAMENTAL_DIFFICULTY_MATRIX,
        "fundamental_targets": FUNDAMENTAL_TARGETS,
        "per_skill_targets": PER_SKILL_TARGETS,
        "skills": [s.model_dump() for s in cv_skills],
        "shortages": shortages, "retrieval_trace": [t.model_dump() for t in trace],
        "retrieval_ms": elapsed_ms,
        "retrieval_providers": {
            "keyword": "meilisearch" if os.getenv("MEILISEARCH_URL") else "relational-fallback",
            "graph": "neo4j" if os.getenv("NEO4J_URI") else "relational-fallback",
        },
    }

def question_page(questions: list[dict], page: int, answers: dict | None = None) -> dict:
    total = len(questions)
    pages = [questions[i:i+QUESTION_PAGE_SIZE] for i in range(0, total, QUESTION_PAGE_SIZE)]
    page = max(0, min(page, max(0, len(pages)-1)))
    rows = []
    for q in pages[page]:
        rows.append({k: q.get(k) for k in ("id", "assessment_section", "assessment_topic", "skill_id",
            "question_type", "difficulty_level", "question_text", "options", "marks", "time_allocation")})
    return {"page": page, "page_size": QUESTION_PAGE_SIZE, "page_count": len(pages),
            "total_questions": total, "questions": rows,
            "answers": {q["id"]: (answers or {}).get(q["id"]) for q in pages[page]},
            "has_previous": page > 0, "has_next": page < len(pages)-1}
