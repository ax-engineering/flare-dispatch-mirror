#!/usr/bin/env -S npx tsx
// @fractalboxdev/flare-dispatch-demo-agent — CLI entry point.
//
// Baked into `registry.cloudflare.com/<account>/flare-dispatch-demo`;
// the `product-demo` run invokes this CLI through `sandbox.exec` for each
// step of an AI-driven product walkthrough — see runs/product-demo.ts.

import * as Command from "@effect/cli/Command";
import { NodeContext, NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { subcommands } from "./commands.js";

const root = Command.make("demo-agent").pipe(
  Command.withSubcommands(subcommands),
);

const cli = Command.run(root, {
  name: "FlareDispatch demo-agent",
  version: "0.0.0",
});

Effect.suspend(() => cli(process.argv)).pipe(
  Effect.provide(NodeContext.layer),
  NodeRuntime.runMain,
);
