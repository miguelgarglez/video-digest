# Project Instructions

## User Preferences

- Maximizar el aprendizaje mientras construimos: explicar brevemente las bases de las decisiones importantes.
- Antes de instalar cualquier dependencia, libreria, paquete o programa en el equipo del usuario, avisar explicitamente y pedir confirmacion.
- No ejecutar instalaciones silenciosas ni implicitas.

## Agent skills

### Issue tracker

Issues live as local markdown files under `.scratch/` until this project has a GitHub remote. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical Matt Pocock triage roles as plain status names for local markdown issues. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context project: use `CONTEXT.md` for domain language and `docs/adr/` for architectural decisions. See `docs/agents/domain.md`.

### npm releases

Future `video-digest` npm releases use the manual Trusted Publishing workflow and
runbook in `docs/runbooks/npm-release.md`. Agents must read that runbook before
changing release automation, bumping package versions, or helping publish a new npm
version.
