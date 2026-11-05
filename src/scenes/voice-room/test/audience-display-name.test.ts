import { describe, expect, it } from "vitest";

import {
  createAudienceDisplayName,
  isAudienceDisplayName,
} from "../audience-display-name";

describe("Audience 英文昵称", () => {
  it("格式为 Alice_037 形式，同一 UID 刷新后稳定", () => {
    const first = createAudienceDisplayName("user-audience-1");
    const refreshed = createAudienceDisplayName("user-audience-1");

    expect(first).toMatch(/^[A-Z][a-z]+_\d{3}$/u);
    expect(refreshed).toBe(first);
    expect(isAudienceDisplayName(first)).toBe(true);
  });

  it("不同 UID 尽量分散到不同名字或数字后缀", () => {
    const names = new Set(Array.from({ length: 100 }, (_, index) =>
      createAudienceDisplayName(`user-audience-${index}`),
    ));

    expect(names.size).toBeGreaterThanOrEqual(98);
  });
});
