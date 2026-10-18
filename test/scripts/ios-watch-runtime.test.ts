import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["ready", "missing", "unrecoverable"])(
  "provisions a usable Watch runtime rather than trusting download state: %s",
  (scenario) => {
    const root = tempDirs.make("openclaw-watch-runtime-");
    const bin = path.join(root, "bin");
    mkdirSync(bin);
    const calls = path.join(root, "calls");
    const tool = String.raw`#!/bin/bash
set -euo pipefail
printf "%s %s\n" "$(basename "$0")" "$*" >> "$FIXTURE_CALLS"
if [[ "$(basename "$0")" == "xcrun" ]]; then
  if [[ "$1 $2" == "simctl create" ]]; then
    if [[ "$FIXTURE_SCENARIO" != "ready" && ! -f "$FIXTURE_ROOT/imported" ]]; then
      echo "runtime path not found" >&2
      exit 145
    fi
    if [[ "$FIXTURE_SCENARIO" == "unrecoverable" ]]; then exit 145; fi
    echo "00000000-0000-0000-0000-000000000001"
  elif [[ "$1 $2" != "simctl delete" || "$3" != "00000000-0000-0000-0000-000000000001" ]]; then
    exit 3
  fi
elif [[ "$1" == "-downloadPlatform" ]]; then
  # A cached download is not evidence that CoreSimulator can create a device.
  if [[ "$#" == 4 ]]; then echo "watchOS 27.0 is already downloaded."; exit 70; fi
  [[ "$5" == "-exportPath" ]]
  touch "$6/watchOS 27.0.simruntime.dmg"
elif [[ "$1" == "-importPlatform" ]]; then
  [[ -f "$2" ]]
  touch "$FIXTURE_ROOT/imported"
else
  exit 3
fi
`;
    for (const name of ["xcrun", "xcodebuild"]) {
      const file = path.join(bin, name);
      writeFileSync(file, tool);
      chmodSync(file, 0o755);
    }
    const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));
    const step = workflow.jobs["ios-screenshot-capture"].steps.find(
      (entry: { name?: string }) => entry.name === "Install Watch screenshot runtime",
    );
    const result = spawnSync("/bin/bash", ["-e", "-c", step.run], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        RUNNER_TEMP: root,
        FIXTURE_ROOT: root,
        FIXTURE_CALLS: calls,
        FIXTURE_SCENARIO: scenario,
      },
    });
    expect(result.status, result.stderr).toBe(scenario === "unrecoverable" ? 145 : 0);
    const observed = readFileSync(calls, "utf8");
    if (scenario === "ready") {
      expect(observed).not.toContain("xcodebuild");
    } else {
      expect(observed).toContain("xcodebuild -importPlatform");
    }
    expect(observed.includes("simctl delete")).toBe(scenario !== "unrecoverable");
  },
);
