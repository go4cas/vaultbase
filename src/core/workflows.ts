/**
 * Durable workflows (F-11) — a code-first, resumable state machine on SQLite.
 *
 * A workflow is an async function that orchestrates `step.run(...)` (a unit of
 * work whose result is memoized) and `step.sleep(...)` (park for a duration).
 * The whole function is RE-EXECUTED from the top each time the run advances
 * (after a sleep, or a process restart). Completed steps return their persisted
 * result WITHOUT re-running — the "memoized steps" model (DBOS / Inngest), which
 * is far simpler to reason about than Temporal-style deterministic replay: your
 * function may contain ordinary control flow, only `step.run` side effects are
 * dedup'd.
 *
 * Guarantees & caveats:
 *  - Each `step.run` side effect executes at-least-once and is memoized after
 *    success, so a resume never repeats a completed step.
 *  - Step names must be unique + stable within a workflow (they're the memo key).
 *  - A crash mid-`step.run` (before its result persists) re-runs that step on
 *    resume — make step bodies idempotent where a repeat would matter.
 *
 * Deferred to F-11b: `step.waitForEvent` (rides the realtime event log),
 * admin-authored workflow definitions (compiled like workers), per-run
 * versioning, and ret/timeout policy.
 */
import { and, eq, lt, lte, or } from "drizzle-orm";
import { getDb } from "../db/client.ts";
import { workflowRuns } from "../db/schema.ts";
import { log } from "./log.ts";

export interface StepApi {
  /** Run a unit of work once; its result is persisted and reused on resume. */
  run<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  /** Park the workflow for `seconds`, resuming after the delay. */
  sleep(name: string, seconds: number): Promise<void>;
}

export type WorkflowFn = (step: StepApi, input: unknown) => Promise<unknown>;

const registry = new Map<string, WorkflowFn>();

/** Register a workflow definition. Idempotent per name (last wins). */
export function defineWorkflow(name: string, fn: WorkflowFn): void {
  registry.set(name, fn);
}

/** Test/reset hook. */
export function _clearWorkflows(): void {
  registry.clear();
}

/** Thrown by `step.sleep` to unwind the function and park the run. */
class Park {
  constructor(public readonly wakeAt: number) {}
}

type StepState = Record<string, { v?: unknown; sleep?: boolean }>;

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

export interface StartResult {
  runId: string;
}

/** Kick off a new run of a registered workflow and advance it once. */
export async function startWorkflow(name: string, input?: unknown): Promise<StartResult> {
  if (!registry.has(name)) throw new Error(`unknown workflow: ${name}`);
  const id = crypto.randomUUID();
  const now = nowSec();
  await getDb()
    .insert(workflowRuns)
    .values({
      id,
      name,
      status: "running",
      input: JSON.stringify(input ?? null),
      steps: "{}",
      output: null,
      error: null,
      wake_at: null,
      created_at: now,
      updated_at: now,
    });
  await advanceWorkflow(id);
  return { runId: id };
}

/**
 * Execute one advancement of a run: replay the workflow function, memoizing
 * completed steps, until it completes, fails, or parks on a sleep.
 */
export async function advanceWorkflow(runId: string): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).limit(1);
  const run = rows[0];
  if (!run || run.status === "completed" || run.status === "failed") return;

  const fn = registry.get(run.name);
  if (!fn) {
    log.error("workflow definition not registered", { scope: "workflows", name: run.name, runId });
    return;
  }

  const steps: StepState = safeParse(run.steps, {});
  const input = safeParse<unknown>(run.input, null);

  const api: StepApi = {
    async run<T>(name: string, f: () => Promise<T> | T): Promise<T> {
      const existing = steps[name];
      if (existing && "v" in existing) return existing.v as T;
      const result = await f();
      steps[name] = { v: result };
      // Persist incrementally so a crash after this step keeps it memoized.
      await db
        .update(workflowRuns)
        .set({ steps: JSON.stringify(steps), updated_at: nowSec() })
        .where(eq(workflowRuns.id, runId));
      return result;
    },
    async sleep(name: string, seconds: number): Promise<void> {
      if (steps[name]?.sleep) return; // already slept — resuming past it
      steps[name] = { sleep: true };
      throw new Park(nowSec() + Math.max(0, Math.floor(seconds)));
    },
  };

  try {
    const output = await fn(api, input);
    await db
      .update(workflowRuns)
      .set({
        status: "completed",
        output: JSON.stringify(output ?? null),
        steps: JSON.stringify(steps),
        wake_at: null,
        updated_at: nowSec(),
      })
      .where(eq(workflowRuns.id, runId));
  } catch (e) {
    if (e instanceof Park) {
      await db
        .update(workflowRuns)
        .set({
          status: "sleeping",
          steps: JSON.stringify(steps),
          wake_at: e.wakeAt,
          updated_at: nowSec(),
        })
        .where(eq(workflowRuns.id, runId));
      return;
    }
    const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
    await db
      .update(workflowRuns)
      .set({ status: "failed", error: msg, steps: JSON.stringify(steps), updated_at: nowSec() })
      .where(eq(workflowRuns.id, runId));
    log.error("workflow failed", { scope: "workflows", name: run.name, runId, error: msg });
  }
}

/**
 * Advance runs that are due: sleeping runs past their wake time, plus `running`
 * runs stranded by a crash (not touched for `STALE_SEC`). Each is claimed with
 * an atomic guarded update so concurrent cluster workers don't double-advance.
 */
const STALE_SEC = 120;

export async function tickWorkflows(): Promise<void> {
  const db = getDb();
  const now = nowSec();
  const staleCutoff = now - STALE_SEC;
  const due = await db
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(
      or(
        and(eq(workflowRuns.status, "sleeping"), lte(workflowRuns.wake_at, now)),
        and(eq(workflowRuns.status, "running"), lt(workflowRuns.updated_at, staleCutoff)),
      ),
    );
  for (const r of due) {
    // Claim: bump to running + fresh updated_at only if still due, so a parallel
    // tick that already grabbed it filters out here.
    const claim = await db
      .update(workflowRuns)
      .set({ status: "running", updated_at: now })
      .where(
        and(
          eq(workflowRuns.id, r.id),
          or(
            eq(workflowRuns.status, "sleeping"),
            and(eq(workflowRuns.status, "running"), lt(workflowRuns.updated_at, staleCutoff)),
          ),
        ),
      )
      .returning({ id: workflowRuns.id });
    if (claim.length === 0) continue;
    await advanceWorkflow(r.id);
  }
}

export interface WorkflowRunView {
  id: string;
  name: string;
  status: string;
  output: unknown;
  error: string | null;
  wake_at: number | null;
}

export async function getWorkflowRun(id: string): Promise<WorkflowRunView | null> {
  const rows = await getDb().select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    output: r.output != null ? safeParse<unknown>(r.output, null) : null,
    error: r.error ?? null,
    wake_at: r.wake_at ?? null,
  };
}

// ── Scheduler ────────────────────────────────────────────────────────────────
let interval: ReturnType<typeof setInterval> | null = null;
const POLL_MS = 1000;

export function startWorkflowScheduler(): void {
  if (interval) return;
  interval = setInterval(() => {
    void tickWorkflows().catch(() => {});
  }, POLL_MS);
}

export function stopWorkflowScheduler(): void {
  if (interval) clearInterval(interval);
  interval = null;
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
