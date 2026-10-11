import { describe, it, expect } from "vitest";
import { renderMetrics } from "@workspace/observability";
import { createSecretBroker, MemorySecretStore } from "./index";

describe("secret broker metrics", () => {
  it("emits secret_broker.expired_credentials when an expired credential is presented", async () => {
    const broker = createSecretBroker(new MemorySecretStore());
    await broker.issueSecret("job-1", "worker-1", -1000, "value-1");

    const value = await broker.getSecret("job-1", "worker-1");

    expect(value).toBeNull();
    expect(renderMetrics()).toContain("# TYPE secret_broker.expired_credentials counter");
    expect(renderMetrics()).toContain("secret_broker.expired_credentials 1");
  });
});