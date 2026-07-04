/**
 * F-11 durable workflows. The engine re-executes the workflow function each time
 * a run advances; completed `step.run` results are memoized so side effects fire
 * exactly once across sleeps and restarts, and `step.sleep` parks the run.
 */
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initDb, closeDb } from "../db/client.ts";
import { runMigrations } from "../db/migrate.ts";
import { setLogsDir } from "../core/file-logger.ts";
import {
  defineWorkflow,
  startWorkflow,
  advanceWorkflow,
  tickWorkflows,
  getWorkflowRun,
  _clearWorkflows,
} from "../core/workflows.ts";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "cogworks-wf-"));
  setLogsDir(tmpDir);
  initDb(":memory:");
  await runMigrations();
  _clearWorkflows();
});
afterEach(() => {
  closeDb();
  try {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    /* swallow */
  }
});

describe("workflows", () => {
  it("runs steps and completes with the returned output", async () => {
    defineWorkflow("greet", async (step, input) => {
      const name = await step.run("who", async () => (input as { name: string }).name);
      const msg = await step.run("msg", async () => `hi ${name}`);
      return { msg };
    });
    const { runId } = await startWorkflow("greet", { name: "Ada" });
    const run = await getWorkflowRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.output).toEqual({ msg: "hi Ada" });
  });

  it("memoizes step.run — side effects fire exactly once across advances", async () => {
    let sideEffects = 0;
    defineWorkflow("once", async (step) => {
      await step.run("charge", async () => {
        sideEffects++;
        return "charged";
      });
      await step.sleep("wait", 0); // parks, then resumes on the next advance
      await step.run("email", async () => "sent");
      return "done";
    });

    const { runId } = await startWorkflow("once", null);
    // First advance parked on the sleep, after running `charge` once.
    expect((await getWorkflowRun(runId))?.status).toBe("sleeping");
    expect(sideEffects).toBe(1);

    // Resume: `charge` must NOT run again (memoized), workflow completes.
    await advanceWorkflow(runId);
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
    expect(sideEffects).toBe(1);
  });

  it("step.sleep parks with a wake time; tickWorkflows resumes when due", async () => {
    defineWorkflow("naps", async (step) => {
      await step.run("a", async () => 1);
      await step.sleep("nap", 60); // 60s in the future
      await step.run("b", async () => 2);
      return "woke";
    });
    const { runId } = await startWorkflow("naps", null);
    const parked = await getWorkflowRun(runId);
    expect(parked?.status).toBe("sleeping");
    expect(parked?.wake_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

    // Not due yet → tick leaves it sleeping.
    await tickWorkflows();
    expect((await getWorkflowRun(runId))?.status).toBe("sleeping");
  });

  it("resumes across a simulated restart (state lives in the DB)", async () => {
    const log: string[] = [];
    const define = () =>
      defineWorkflow("resume", async (step) => {
        await step.run("s1", async () => {
          log.push("s1");
          return 1;
        });
        await step.sleep("gap", 0);
        await step.run("s2", async () => {
          log.push("s2");
          return 2;
        });
        return "ok";
      });
    define();
    const { runId } = await startWorkflow("resume", null);
    expect((await getWorkflowRun(runId))?.status).toBe("sleeping");

    // Simulate a restart: clear the in-memory registry, re-register, resume.
    _clearWorkflows();
    define();
    await advanceWorkflow(runId);
    expect((await getWorkflowRun(runId))?.status).toBe("completed");
    // s1 ran once (before restart), s2 ran once (after) — no repeats.
    expect(log).toEqual(["s1", "s2"]);
  });

  it("marks the run failed when a step throws", async () => {
    defineWorkflow("boom", async (step) => {
      await step.run("explode", async () => {
        throw new Error("kaboom");
      });
      return "never";
    });
    const { runId } = await startWorkflow("boom", null);
    const run = await getWorkflowRun(runId);
    expect(run?.status).toBe("failed");
    expect(run?.error).toContain("kaboom");
  });

  it("rejects starting an unregistered workflow", async () => {
    await expect(startWorkflow("ghost", null)).rejects.toThrow(/unknown workflow/);
  });
});
