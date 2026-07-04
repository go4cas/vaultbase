/**
 * Admin operator roles (roadmap F-9).
 *
 * Four ascending roles gate the CONTROL PLANE — schema, server-side code, ops
 * config, credentials, and admin management. They do NOT (yet) govern the DATA
 * PLANE: an admin of any role still bypasses collection rules on the records API
 * (see `core/rules.ts` — per-record viewer/editor enforcement is a documented
 * follow-up tracked with E-14). The reviewer's headline ask was to stop "admin"
 * from meaning "host RCE"; that lives entirely on the control plane, here.
 *
 *   viewer     — read-only operator (view logs, metrics, schema)
 *   editor     — + manage app data through the admin UI (records/users/files)
 *   developer  — + schema, hooks, routes, jobs, queues, SQL runner, migrations,
 *                indexes, webhooks, flags, MCP admin (the RCE-class surface)
 *   owner      — + admin management, settings, backup/restore, API-token minting,
 *                security/session control
 *
 * Enforcement is centralized in one classification table (`CONTROL_PLANE_RULES`)
 * consumed by the role-gate middleware, rather than scattered across ~16 plugins.
 */

export const ADMIN_ROLES = ["viewer", "editor", "developer", "owner"] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

const RANK: Record<AdminRole, number> = { viewer: 0, editor: 1, developer: 2, owner: 3 };

export function isAdminRole(v: unknown): v is AdminRole {
  return typeof v === "string" && (ADMIN_ROLES as readonly string[]).includes(v);
}

/** Coerce a stored value to a role, defaulting to `owner` (pre-RBAC rows). */
export function normalizeRole(v: unknown): AdminRole {
  return isAdminRole(v) ? v : "owner";
}

/** True iff `have` meets or exceeds `need`. */
export function roleAtLeast(have: AdminRole, need: AdminRole): boolean {
  return RANK[have] >= RANK[need];
}

/** Numeric rank, for comparisons like "cannot assign a role above your own". */
export function roleRank(role: AdminRole): number {
  return RANK[role];
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

interface ControlPlaneRule {
  /** Path prefix, matched against the request path with the `/api/v1` prefix stripped. */
  prefix: string;
  /** When set, the rule applies only to these methods; otherwise all methods. */
  methods?: Method[];
  role: AdminRole;
}

/**
 * Ordered — first match wins. Every entry is an admin-only control-plane path;
 * observability reads (logs, audit, metrics) are intentionally absent so any
 * authenticated admin (viewer+) keeps them, gated only by each plugin's own
 * `requireAdmin`. Keep this list the single source of truth for capability tiers.
 */
const CONTROL_PLANE_RULES: ControlPlaneRule[] = [
  // ── owner: credentials, settings, backup, admin management ──
  { prefix: "/admin/admins", role: "owner" },
  { prefix: "/admin/settings", role: "owner" },
  { prefix: "/admin/backup", role: "owner" },
  { prefix: "/admin/restore", role: "owner" },
  { prefix: "/admin/api-tokens", role: "owner" },
  { prefix: "/admin/security", role: "owner" },
  // ── developer: schema, server-side code, ops config (the RCE-class surface) ──
  { prefix: "/admin/hooks", role: "developer" },
  { prefix: "/admin/routes", role: "developer" },
  { prefix: "/admin/jobs", role: "developer" },
  { prefix: "/admin/workers", role: "developer" },
  { prefix: "/admin/queues", role: "developer" },
  { prefix: "/admin/sql", role: "developer" },
  { prefix: "/admin/migrations", role: "developer" },
  { prefix: "/admin/mcp", role: "developer" },
  { prefix: "/admin/webhooks", role: "developer" },
  { prefix: "/admin/flags", role: "developer" },
  { prefix: "/admin/flag-segments", role: "developer" },
  { prefix: "/admin/update-status", role: "developer" },
  { prefix: "/admin/collections", role: "developer" }, // stats + index management
  // Collection SCHEMA writes (create/patch/delete). GET /collections stays open to any admin.
  { prefix: "/collections", methods: ["POST", "PATCH", "PUT", "DELETE"], role: "developer" },
];

/** Strip the API version prefix so rules match on the logical path. */
function logicalPath(path: string): string {
  return path.replace(/^\/api\/v1/, "");
}

/**
 * The minimum role required to call `method path`, or `null` when the path is
 * not a gated control-plane route (the caller then falls through to the
 * endpoint's own auth). Pure — unit-tested in isolation.
 */
export function classifyRequiredRole(method: string, path: string): AdminRole | null {
  const p = logicalPath(path);
  const m = method.toUpperCase() as Method;
  for (const rule of CONTROL_PLANE_RULES) {
    if (!p.startsWith(rule.prefix)) continue;
    if (rule.methods && !rule.methods.includes(m)) continue;
    return rule.role;
  }
  return null;
}
