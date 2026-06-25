import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { TokenGate, notifyAuthExpired, isAuthExpiredError } from "../src/components/TokenGate";
import { ApiError } from "../src/api/types";

const KEY = "rpa.token";

beforeEach(() => {
  localStorage.removeItem(KEY);
  window.history.replaceState(null, "", "/");
});
afterEach(() => {
  localStorage.removeItem(KEY);
  window.history.replaceState(null, "", "/");
});

// 2차 온보딩·접근: 세션을 끊어야 하는 인증 실패(401/UNAUTHENTICATED)만 판정 — 권한부족(403)은 세션 유지.
describe("isAuthExpiredError — 세션 만료만 판정", () => {
  test("401 → true", () => {
    expect(isAuthExpiredError(new ApiError(401, "UNAUTHENTICATED", null))).toBe(true);
  });
  test("코드 UNAUTHENTICATED(상태 무관) → true", () => {
    expect(isAuthExpiredError(new ApiError(400, "UNAUTHENTICATED", null))).toBe(true);
  });
  test("403 권한부족 → false(세션 유지, 화면별 처리)", () => {
    expect(isAuthExpiredError(new ApiError(403, "AUTHZ_FORBIDDEN", null))).toBe(false);
  });
  test("비-ApiError → false", () => {
    expect(isAuthExpiredError(new Error("x"))).toBe(false);
    expect(isAuthExpiredError(null)).toBe(false);
  });
});

describe("TokenGate — 접속/온보딩 + 세션 만료", () => {
  test("토큰 없으면 접속 화면 + 발급처 안내(어디서 받는지)", () => {
    render(
      <TokenGate>
        <div>APP</div>
      </TokenGate>,
    );
    expect(screen.getByRole("heading", { name: "RPA 운영 콘솔 접속" })).toBeInTheDocument();
    expect(screen.getByText(/관리자 또는 IT 담당자가 발급/)).toBeInTheDocument();
    expect(screen.queryByText("APP")).toBeNull();
  });

  test("빈 접속 코드 제출 → 인라인 피드백, 입장 안 됨(조용한 무시 금지)", () => {
    render(
      <TokenGate>
        <div>APP</div>
      </TokenGate>,
    );
    fireEvent.click(screen.getByRole("button", { name: "운영 콘솔 접속" }));
    expect(screen.getByText("접속 코드를 입력하세요.")).toBeInTheDocument();
    expect(screen.queryByText("APP")).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  test("유효 접속 코드 제출 → 입장 + localStorage 저장", () => {
    render(
      <TokenGate>
        <div>APP</div>
      </TokenGate>,
    );
    fireEvent.change(screen.getByLabelText("접속 코드"), { target: { value: "eyJ.aaa.bbb" } });
    fireEvent.click(screen.getByRole("button", { name: "운영 콘솔 접속" }));
    expect(screen.getByText("APP")).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("eyJ.aaa.bbb");
  });

  test("OIDC 리디렉션 토큰(fragment)을 자동 저장하고 URL에서 제거", async () => {
    // #C1: 토큰은 fragment(hash)로만 수용(쿼리스트링 누출 차단). 소비 후 해시에서 토큰 스크럽.
    window.history.replaceState(null, "", "/#id_token=oidc.jwt.token");
    render(
      <TokenGate>
        <div>APP</div>
      </TokenGate>,
    );
    expect(await screen.findByText("APP")).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBe("oidc.jwt.token");
    expect(window.location.hash).toBe("");
  });

  test("쿼리스트링 토큰은 거부 — 게이트 유지·미저장(#C1 access-log 누출 방지)", () => {
    window.history.replaceState(null, "", "/?id_token=oidc.jwt.token");
    render(
      <TokenGate>
        <div>APP</div>
      </TokenGate>,
    );
    expect(screen.queryByText("APP")).toBeNull(); // 쿼리 토큰 미수용 → 미입장
    expect(localStorage.getItem(KEY)).toBeNull(); // 미저장
  });

  test("세션 만료(notifyAuthExpired) → 토큰 제거 + 만료 안내 + 게이트 복귀(리로드 없이)", () => {
    localStorage.setItem(KEY, "eyJ.valid.tok");
    render(
      <TokenGate>
        <div>APP</div>
      </TokenGate>,
    );
    expect(screen.getByText("APP")).toBeInTheDocument(); // 처음엔 입장
    act(() => notifyAuthExpired());
    expect(screen.queryByText("APP")).toBeNull();
    expect(screen.getByText(/세션이 만료되었거나 접속 권한을 확인할 수 없습니다/)).toBeInTheDocument();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});
