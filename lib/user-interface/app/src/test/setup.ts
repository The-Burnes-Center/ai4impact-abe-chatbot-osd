import "@testing-library/jest-dom";
import { expect } from "vitest";
import * as matchers from "vitest-axe/matchers";

expect.extend(matchers);

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  interface Assertion<T = any> extends matchers.AxeMatchers {
    _phantom?: T;
  }
  interface AsymmetricMatchersContaining extends matchers.AxeMatchers {}
}
