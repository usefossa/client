import { mock } from "bun:test";

// opencode uses solid's client runtime; bun otherwise selects its nonreactive server runtime.
const solid = require("solid-js/dist/solid.js");
mock.module("solid-js", () => solid);
await import("@opentui/solid/runtime-plugin-support");
