/**
 * Project entries on the candidate profile. Field names follow the
 * experience entries the CV extraction already uses (description,
 * technologies, start_date, end_date) so nothing typed by the candidate is
 * dropped between load, edit and save.
 */
export const PROJECT_DEFAULTS = { name: "", url: "", description: "", technologies: [], start_date: "", end_date: "" };

export function splitTechnologies(value, { keepEmpty = false } = {}) {
  const parts = Array.isArray(value) ? value.map(String) : String(value || "").split(",");
  const cleaned = keepEmpty ? parts.map((part) => part.replace(/^\s+/, "")) : parts.map((part) => part.trim()).filter(Boolean);
  return cleaned;
}

/** Normalise one project for the form; unknown extra fields are kept. */
export function normalizeProject(item) {
  const source = item && typeof item === "object" ? item : {};
  const { project_url, ...rest } = source;
  return {
    ...PROJECT_DEFAULTS,
    ...rest,
    name: String(source.name || ""),
    url: String(source.url || project_url || ""),
    description: String(source.description || ""),
    technologies: splitTechnologies(source.technologies),
    start_date: String(source.start_date || ""),
    end_date: String(source.end_date || ""),
  };
}

/** Clean projects for saving: trims text and removes empty technologies. */
export function projectsForSave(projects) {
  return (projects || []).map((item) => {
    const project = normalizeProject(item);
    return {
      ...project,
      name: project.name.trim(),
      url: project.url.trim(),
      description: project.description.trim(),
      start_date: project.start_date.trim(),
      end_date: project.end_date.trim(),
    };
  });
}
