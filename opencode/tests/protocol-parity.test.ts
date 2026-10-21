import { expect, test } from "bun:test";
import { join } from "node:path";
import { inputBound, validateBody } from "../src/protocol";

test.skipIf(!process.env.FOSSA_PROVIDER_ROOT)("rust and client share request and input-accounting fixtures", async () => {
  const root = process.env.FOSSA_PROVIDER_ROOT!;
  const fixtures = await Bun.file(join(root, "tests/fixtures/protocol.json")).json();
  const config = { ...fixtures.model, model: fixtures.model.id, tools: true, speed_tps: 100, effort: fixtures.model.reasoning_mode === "toggle" ? ["none", "high"] : fixtures.model.effort };
  for (const input of fixtures.cases) {
    const booking = { ...input.booking, claimEnd: Date.now() / 1000 + (input.expected.error === "Booking deadline too short" ? 1 : 600) };
    let actual;
    try { actual = { max: validateBody(input.body, booking, config) }; }
    catch (error) { actual = { error: (error as Error).message }; }
    expect(actual).toEqual(input.expected);
  }
  for (const input of await Bun.file(join(root, "tests/fixtures/input-bounds.json")).json()) expect(inputBound(JSON.parse(input.raw), 1048576)).toBe(input.expected);
});
