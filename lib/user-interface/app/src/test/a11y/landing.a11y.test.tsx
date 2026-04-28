import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { axe } from "vitest-axe";
import { MemoryRouter } from "react-router-dom";

import NotFoundPage from "../../pages/not-found";
import SkipLink from "../../components/mds/SkipLink";
import LandingPage from "../../pages/landing-page";
import LandingPageInfo from "../../pages/landing-page-info";
import LandingPageStart from "../../pages/landing-page-start";
import HelpInformation from "../../pages/help/help-information";

/**
 * Smoke-level WCAG 2.1 AA gate.
 *
 * Mounts the screens that render statically without auth or data fixtures
 * and asserts axe-core finds no violations. Heavier pages (chat, admin)
 * are still tested manually via axe DevTools because they require live
 * auth + API responses the unit-test environment doesn't carry.
 *
 * Adding a new screen to this file is the cheapest way to catch a11y
 * regressions in CI.
 */

function renderInRouter(ui: React.ReactElement, route = "/") {
  return render(
    <MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>
  );
}

describe("a11y smoke", () => {
  it("SkipLink has no accessibility violations", async () => {
    const { container } = render(<SkipLink />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Not-Found page has no accessibility violations", async () => {
    const { container } = renderInRouter(<NotFoundPage />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Landing page (/) has no accessibility violations", async () => {
    const { container } = renderInRouter(<LandingPage />);
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Landing page · About has no accessibility violations", async () => {
    const { container } = renderInRouter(<LandingPageInfo />, "/about");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Landing page · Get-started has no accessibility violations", async () => {
    const { container } = renderInRouter(<LandingPageStart />, "/get-started");
    expect(await axe(container)).toHaveNoViolations();
  });

  it("Help information section has no accessibility violations", async () => {
    const { container } = render(
      <main>
        <h1>Help</h1>
        <HelpInformation />
      </main>
    );
    expect(await axe(container)).toHaveNoViolations();
  });
});
