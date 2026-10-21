import { Rpc } from "@opencode/plugin";

const object = { type: "object", additionalProperties: true } as const;
const errors = { fossa: object } as const;
const empty = { type: "object", additionalProperties: false } as const;
export const Fossa = Rpc.define({
  id: "fossa",
  methods: {
    attach: { input: { type: "object", properties: { instance: { type: "string" } }, required: ["instance"], additionalProperties: false }, output: object, errors },
    status: { input: empty, output: object, errors },
    endpoint: { input: { type: "object", properties: { apiUrl: { type: "string" } }, additionalProperties: false }, output: object, errors },
    routes: { input: { type: "object", properties: { session: { type: "string" } }, required: ["session"], additionalProperties: false }, output: object, errors },
    wallets: { input: empty, output: object, errors },
    unlock: { input: { type: "object", properties: { passphrase: { type: "string" } }, required: ["passphrase"], additionalProperties: false }, output: object, errors },
    lock: { input: empty, output: object, errors },
    security: { input: { type: "object", properties: { action: { enum: ["enable", "disable"] }, passphrase: { type: "string" } }, additionalProperties: false }, output: object, errors },
    settings: { input: object, output: object, errors },
    model: { input: { type: "object", properties: { model: { type: "string" } }, required: ["model"], additionalProperties: false }, output: object, errors },
    recover: { input: empty, output: object, errors },
    rakeback: { input: object, output: object, errors },
  },
  events: { updated: { schema: object }, unlockRequired: { schema: object } },
});
