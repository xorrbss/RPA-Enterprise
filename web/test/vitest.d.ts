import "vitest";

// vitest-axe 매처(toHaveNoViolations)를 vitest expect에 타입 보강.
interface AxeCustomMatchers<R = unknown> {
  toHaveNoViolations(): R;
}

declare module "vitest" {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Assertion<T = unknown> extends AxeCustomMatchers<T> {}
  interface AsymmetricMatchersContaining extends AxeCustomMatchers {}
}
