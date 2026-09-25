# 0006: Admin console inside the web app

**Status:** accepted, 2026-09-25

**Decision.** The moderation and admin console lives at `/admin` in the web app instead of a separate `apps/admin`.

**Why.** It reuses the design system, API client and session handling. Security doesn't depend on the UI: every admin endpoint enforces RBAC on the server.

**Consequences.** If the admin team needs a separate domain, network restrictions or SSO, the `/admin` pages move into `apps/admin` unchanged.
