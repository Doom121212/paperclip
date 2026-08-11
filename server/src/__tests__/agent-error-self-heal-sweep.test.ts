import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("../telemetry.ts", () => ({ getTelemetryClient: () => mockTelemetryClient }));

import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres agent error self-heal tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

/**
 * ORU-582, end to end against a real database: an agent driven into `error` by
 * a provider limit comes back on its own once the limit resets, and one driven
 * there by a lost process comes back on the next sweep. Neither needs a human
 * to PATCH it — which is what happened five times on 11 Aug 2026.
 */
describeEmbeddedPostgres("heartbeat sweepRecoverableAgentErrors", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agent-self-heal-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(heartbeatRunEvents);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  const PARKED_AT = new Date("2026-08-11T14:38:00.000Z");
  // 22:23 Berlin on 11 Aug: where the five parked agents were found.
  const FOUND_AT = new Date("2026-08-11T20:23:00.000Z");

  async function parkAgent(input: {
    errorReason: string;
    run: { status: string; errorCode: string | null; error: string | null; resultJson?: Record<string, unknown> };
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Noor",
      role: "engineer",
      status: "error",
      errorReason: input.errorReason,
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: input.run.status,
      invocationSource: "automation",
      errorCode: input.run.errorCode,
      error: input.run.error,
      resultJson: input.run.resultJson ?? null,
      startedAt: PARKED_AT,
      finishedAt: PARKED_AT,
    });
    return { companyId, agentId };
  }

  async function readAgent(agentId: string) {
    return db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0]!);
  }

  it("returns a quota-parked agent to idle once the quoted reset has passed", async () => {
    const { agentId } = await parkAgent({
      errorReason: "session limit · resets 10:10pm (Europe/Berlin)",
      run: {
        status: "failed",
        errorCode: "provider_quota",
        error: "session limit · resets 10:10pm (Europe/Berlin)",
        resultJson: { errorFamily: "provider_quota" },
      },
    });
    const heartbeat = heartbeatService(db);

    // 21:00 Berlin — the limit is still binding, so the agent stays parked.
    const early = await heartbeat.sweepRecoverableAgentErrors(new Date("2026-08-11T19:00:00.000Z"));
    expect(early.cleared).toBe(0);
    expect((await readAgent(agentId)).status).toBe("error");

    // 22:23 Berlin — thirteen minutes past the reset. No human involved.
    const late = await heartbeat.sweepRecoverableAgentErrors(FOUND_AT);
    expect(late.cleared).toBe(1);
    expect(late.clearedAgents).toEqual([{ agentId, reason: "provider_quota" }]);

    const healed = await readAgent(agentId);
    expect(healed.status).toBe("idle");
    // The reason is the frozen copy of one failure; it must not outlive the park.
    expect(healed.errorReason).toBeNull();
  });

  it("returns a process-lost agent to idle on the next sweep", async () => {
    const { agentId } = await parkAgent({
      errorReason: "Process lost -- child pid 3571518 is no longer running",
      run: {
        status: "failed",
        errorCode: "process_lost",
        error: "Process lost -- child pid 3571518 is no longer running",
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.sweepRecoverableAgentErrors(FOUND_AT);

    expect(result.clearedAgents).toEqual([{ agentId, reason: "process_lost" }]);
    expect(await readAgent(agentId)).toMatchObject({ status: "idle", errorReason: null });
  });

  it("leaves an agent parked on a genuine work failure", async () => {
    const { agentId } = await parkAgent({
      errorReason: "Agent turn failed: tool call raised TypeError",
      run: {
        status: "failed",
        errorCode: "acpx_turn_failed",
        error: "ACP_TURN_FAILED: the tool call raised TypeError",
      },
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.sweepRecoverableAgentErrors(FOUND_AT);

    expect(result.cleared).toBe(0);
    expect(result.held).toEqual([{ agentId, reason: "not_recoverable" }]);
    expect(await readAgent(agentId)).toMatchObject({ status: "error" });
  });

  it("leaves an agent alone while one of its runs is still running", async () => {
    const { companyId, agentId } = await parkAgent({
      errorReason: "Process lost -- server may have restarted",
      run: { status: "failed", errorCode: "process_lost", error: "Process lost -- server may have restarted" },
    });
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      invocationSource: "automation",
      startedAt: FOUND_AT,
    });
    const heartbeat = heartbeatService(db);

    const result = await heartbeat.sweepRecoverableAgentErrors(FOUND_AT);

    expect(result.cleared).toBe(0);
    expect(await readAgent(agentId)).toMatchObject({ status: "error" });
  });
});
