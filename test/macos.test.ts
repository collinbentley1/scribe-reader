import { expect, test } from "bun:test";
import { parseMacCommand } from "../scripts/macos.js";

test("signing commands keep ad hoc and Developer ID requirements distinct", () => {
  const app = "/isolated/Scribe Reader.app";
  expect(parseMacCommand(["sign", "--app", app, "--mode", "adhoc"])).toEqual({
    kind: "sign",
    app,
    signing: { kind: "adhoc" },
    identity: "-",
  });
  expect(() =>
    parseMacCommand([
      "sign",
      "--app",
      app,
      "--mode",
      "adhoc",
      "--identity",
      "identity",
    ]),
  ).toThrow("invalid-signing-mode");
  expect(() =>
    parseMacCommand([
      "sign",
      "--app",
      app,
      "--mode",
      "developer-id",
      "--team",
      "ABCDEFGHIJ",
      "--identity",
      "-",
    ]),
  ).toThrow("developer-id-identity-required");
  expect(() =>
    parseMacCommand(["verify", "--app", app, "--mode", "developer-id"]),
  ).toThrow("invalid-signing-mode");
  expect(() =>
    parseMacCommand(["build", "--out", "/output", "--out", "/other"]),
  ).toThrow("invalid-arguments");
  expect(() =>
    parseMacCommand(["build", "--out", "/output", "--credentials", "/file"]),
  ).toThrow("invalid-arguments");
});
