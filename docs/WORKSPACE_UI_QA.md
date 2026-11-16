# Workspace UI and workflow verification

## Design

`frontend/src/workspace.css` is the shared operational design system: dark navigation, mint/teal accents, consistent surfaces, readable forms, responsive grids and visible focus indicators. The public landing page is intentionally unchanged. Existing live-assessment layouts remain separate.

Shared UI lives in `frontend/src/WorkspaceUI.jsx`. Page search supports Ctrl/Cmd+K, arrow keys, Enter and Escape. Search, candidate records and application reports use native dialogs for keyboard focus containment. Small screens use horizontally scrollable navigation rather than squeezing desktop sidebars into the viewport.

## CV display

- API requests accept both `/admin/...` and server-returned `/api/admin/...` paths without adding `/api` twice.
- PDF bytes are fetched with the current bearer token, then previewed through a temporary browser blob URL. Tokens are not put into download URLs.
- Admin candidate records and company application reports have inline previews, downloads, error messages and retry actions. Unsupported PDF viewers can use the open/download links instead.
- Preview URLs are revoked on unmount. Existing backend tenant/role checks and candidate result-sharing consent remain in force.
- A missing historical CV cannot be recreated if the original file was never stored; ask the candidate to upload it again.

## Team access

1. An owner opens **Team**, enters the colleague's email and chooses Recruiter, Hiring Manager or Viewer.
2. The colleague signs up/signs in with a **company** account using the invited email. If email verification is enabled, verify that email first.
3. On company setup, the colleague uses **Join team** under their invitations, or pastes the securely shared token. They should not create another company first.
4. The owner can change an active member's role, revoke access, or issue a fresh invitation. A fresh token invalidates the older token. Revoked accounts must accept a new invitation before access is restored.

Invitations use manual delivery; the UI explicitly says no email was sent. The current product supports **one organisation per account**, not a multi-tenant workspace switcher. Existing organisation owners/members receive an explicit conflict instead of accepting an invitation that would be hidden by their current workspace.

## Automated checks

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest -q tests
cd ../frontend
npm ci
npm test
npx playwright install chromium
npm run test:e2e
npm run lint
npm run build
npm audit
```

- Backend tests exercise real SQLite-backed CV upload/retrieval, company isolation, invitation discovery/acceptance, permission changes, token rotation, revocation and verified-email enforcement.
- Playwright tests use **synthetic mocked API fixtures**, not a deployed backend. They exercise Chromium desktop/mobile layouts, navigation/search, profile rendering, job application interaction, CV preview/download/retry and team invitation/role controls. Screenshots and traces are written into ignored `frontend/test-results/`.
- API unit tests cover URL normalization, rejection of external credential destinations and binary authenticated downloads.

## Deployment smoke test still required

Use real staging accounts to repeat CV upload → admin preview → apply → company preview, then invite → accept → change role → revoke → re-invite. Test the deployed Vercel/Render API origin, PostgreSQL, production MFA and email verification settings. Browser-local screen sharing, camera/microphone integrations, external AI/model downloads, billing and experimental phase-two delivery are not certified by these UI tests. Existing roadmap/prototype limitations are not removed by this redesign.
