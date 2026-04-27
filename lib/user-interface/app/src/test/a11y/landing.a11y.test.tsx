import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { MemoryRouter } from "react-router-dom";

import NotFoundPage from "../../pages/not-found";
import SkipLink from "../../components/mds/SkipLink";

/**
 * Smoke-level WCAG 2.1 AA gate.
 *
 * Mounts a small set of always-statically-renderable building blocks and
 * asserts that axe-core finds no violations. Heavier pages (chat, admin)
 * are tested manually via axe DevTools because they require auth/data
 * fixtures the unit-test environment doesn't carry.
 *
 * Adding a new screen to this file is the cheapest way to catch a11y
 * regressions in CI.
 */

describe("a11y smoke", () => {
  it("SkipLink has no accessibility violations", async () => {
    const { container } = render(<SkipLink />);
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });

  it("Not-Found page has no accessibility violations", async () => {
    const { container } = render(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>
    );
    const results = await axe(container);
    expect(results).toHaveNoViolations();
  });
});
