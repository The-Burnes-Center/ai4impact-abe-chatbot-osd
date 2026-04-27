import "@testing-library/jest-dom";
import { expect } from "vitest";
import * as matchers from "vitest-axe/matchers";

expect.extend(matchers);

declare module "vitest" {
  interface Assertion<T = unknown> extends matchers.AxeMatchers {
    /** present so the generic param is used; vitest-axe matchers attach via expect.extend */
    _phantom?: T;
  }
  interface AsymmetricMatchersContaining extends matchers.AxeMatchers {}
}
