/*
 * SPDX-FileCopyrightText: 2026 Pagefault Games
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { ServiceRegistry } from "#app/service-registry";
import { describe, expect, it, vi } from "vitest";

describe("Host - service registry", () => {
  it("runs pre-destroy hooks in reverse registration order", () => {
    const registry = new ServiceRegistry();
    const calls: string[] = [];

    registry.register("settings", { beforeGameDestroy: () => calls.push("settings"), reset: vi.fn() });
    registry.register("audio", { beforeGameDestroy: () => calls.push("audio"), reset: vi.fn() });

    registry.beforeGameDestroy();

    expect(calls).toEqual(["audio", "settings"]);
  });

  it("resets every service in reverse registration order", () => {
    const registry = new ServiceRegistry();
    const calls: string[] = [];

    registry.register("first", { reset: () => calls.push("first") });
    registry.register("second", { reset: () => calls.push("second") });

    registry.reset();

    expect(calls).toEqual(["second", "first"]);
  });

  it("replaces a registration without calling the old service", () => {
    const registry = new ServiceRegistry();
    const oldReset = vi.fn();
    const newReset = vi.fn();

    registry.register("settings", { reset: oldReset });
    registry.register("settings", { reset: newReset });
    registry.reset();

    expect(oldReset).not.toHaveBeenCalled();
    expect(newReset).toHaveBeenCalledOnce();
  });

  it("continues cleanup after a hook throws and reports all errors", () => {
    const registry = new ServiceRegistry();
    const laterReset = vi.fn();
    const firstError = new Error("audio teardown failed");
    const secondError = new Error("settings teardown failed");

    registry.register("first", {
      reset: () => {
        throw firstError;
      },
    });
    registry.register("second", {
      reset: () => {
        laterReset();
        throw secondError;
      },
    });

    let thrown: unknown;
    try {
      registry.reset();
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors).toEqual([secondError, firstError]);
    expect(laterReset).toHaveBeenCalledOnce();
  });
});
