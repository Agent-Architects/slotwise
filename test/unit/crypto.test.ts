import { describe, expect, it } from "vitest";
import { hashPassword, SecretBox, verifyPassword } from "../../src/core/crypto";

describe("crypto", () => {
  it("hashes and verifies passwords", async () => {
    const h = await hashPassword("correct horse battery");
    expect(h).toMatch(/^pbkdf2-sha256\$100000\$/);
    expect(await verifyPassword("correct horse battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("seals and opens secrets with AES-GCM and detects tampering", async () => {
    const box = new SecretBox(Buffer.alloc(32, 1).toString("base64"));
    const s = await box.seal("refresh-token-xyz");
    expect(s).not.toContain("refresh-token-xyz");
    expect(await box.open(s)).toBe("refresh-token-xyz");
    const tampered = s.slice(0, -2) + (s.endsWith("A") ? "BB" : "AA");
    await expect(box.open(tampered)).rejects.toThrow();
    const other = new SecretBox(Buffer.alloc(32, 2).toString("base64"));
    await expect(other.open(s)).rejects.toThrow();
  });
  it("rejects short keys", () => {
    expect(() => new SecretBox(Buffer.alloc(16).toString("base64"))).toThrow();
  });
});

import { initials } from "../../web/text";
describe("initials", () => {
  it("uses letters only", () => {
    expect(initials("Dana 2 Dee")).toBe("DD");
    expect(initials("Ann Owner")).toBe("AO");
    expect(initials("<<< >>>")).toBe("?");
    expect(initials("élodie  Ünal extra")).toBe("ÉÜ");
  });
});
