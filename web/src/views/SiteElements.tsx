import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { useCan } from "../api/permissions";
import type {
  SiteElementCreateBody,
  SiteElementItem,
  SiteElementProbeResponse,
  SiteElementStability,
  SiteItem,
} from "../api/types";
import { ErrorState, Loading } from "../components/states";
import { errorLabel } from "../components/badges";
import { ElementForm, cleanCreateBody, cleanUpdateBody } from "./site-elements/ElementForm";
import { RepositorySummary } from "./site-elements/RepositorySummary";
import {
  EMPTY_FORM,
  PROBE_LABEL,
  STABILITIES,
  STABILITY_LABEL,
  TYPE_LABEL,
  appendUniqueElements,
  appendUniqueSites,
  formatCount,
  probeMatchLabel,
  probeMessageTone,
  probeReasonLabel,
  probeTone,
  stabilityTone,
  type BulkProbeItem,
  type BulkProbeState,
} from "./site-elements/helpers";

export function SiteElementsView(): JSX.Element {
  const api = useApiClient();
  const can = useCan();
  const qc = useQueryClient();
  const [selectedSiteId, setSelectedSiteId] = useState<string>("");
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [stability, setStability] = useState<"all" | SiteElementStability>("all");
  const [search, setSearch] = useState("");
  const [form, setForm] = useState<SiteElementCreateBody>(EMPTY_FORM);
  const [message, setMessage] = useState<{ tone: "green" | "amber" | "red"; text: string } | null>(null);
  const [probeResult, setProbeResult] = useState<SiteElementProbeResponse | null>(null);
  const [bulkProbe, setBulkProbe] = useState<BulkProbeState | null>(null);
  const [siteCursor, setSiteCursor] = useState<string | null>(null);
  const [nextSiteCursor, setNextSiteCursor] = useState<string | null>(null);
  const [loadedSites, setLoadedSites] = useState<SiteItem[]>([]);
  const [elementCursor, setElementCursor] = useState<string | null>(null);
  const [nextElementCursor, setNextElementCursor] = useState<string | null>(null);
  const [loadedElements, setLoadedElements] = useState<SiteElementItem[]>([]);

  const sitesQuery = useQuery({
    queryKey: ["sites", { limit: 100, cursor: siteCursor }],
    queryFn: () => api.listSites({ limit: 100, ...(siteCursor !== null ? { cursor: siteCursor } : {}) }),
  });
  const sites = loadedSites;
  const hasMoreSites = nextSiteCursor !== null;

  useEffect(() => {
    if (sitesQuery.data === undefined) return;
    setLoadedSites((prev) => siteCursor === null ? [...sitesQuery.data.items] : appendUniqueSites(prev, sitesQuery.data.items));
    setNextSiteCursor(sitesQuery.data.next_cursor);
  }, [siteCursor, sitesQuery.data]);

  useEffect(() => {
    if (selectedSiteId === "" && sites[0] !== undefined) setSelectedSiteId(sites[0].site_profile_id);
  }, [selectedSiteId, sites]);

  const selectedSite = useMemo(
    () => sites.find((site) => site.site_profile_id === selectedSiteId) ?? null,
    [selectedSiteId, sites],
  );

  const elementParams = useMemo(
    () => ({
      limit: 100,
      ...(stability !== "all" ? { stability } : {}),
      ...(search.trim() !== "" ? { search: search.trim() } : {}),
    }),
    [search, stability],
  );

  const elementsQuery = useQuery({
    queryKey: ["site-elements", selectedSiteId, elementParams, elementCursor],
    queryFn: () => api.listSiteElements(selectedSiteId, { ...elementParams, ...(elementCursor !== null ? { cursor: elementCursor } : {}) }),
    enabled: selectedSiteId !== "",
  });

  const elements = loadedElements;
  const hasMoreElements = nextElementCursor !== null;
  const isFetchingMoreElements = elementsQuery.isFetching && elementCursor !== null;

  function resetElementList(): void {
    setElementCursor(null);
    setNextElementCursor(null);
    setLoadedElements([]);
  }

  useEffect(() => {
    if (elementsQuery.data === undefined) return;
    setLoadedElements((prev) => elementCursor === null ? [...elementsQuery.data.items] : appendUniqueElements(prev, elementsQuery.data.items));
    setNextElementCursor(elementsQuery.data.next_cursor);
  }, [elementCursor, elementsQuery.data]);

  useEffect(() => {
    if (elementCursor !== null || elementsQuery.data === undefined || loadedElements.length > 0 || elementsQuery.data.items.length === 0) return;
    setLoadedElements([...elementsQuery.data.items]);
    setNextElementCursor(elementsQuery.data.next_cursor);
  }, [elementCursor, elementsQuery.data, loadedElements.length]);

  const selectedElement = useMemo(
    () => (isCreating ? null : elements.find((item) => item.element_id === selectedElementId) ?? elements[0] ?? null),
    [elements, isCreating, selectedElementId],
  );
  const summary = useMemo(() => {
    const unstableElements = elements
      .filter((element) => element.stability !== "stable")
      .sort((a, b) => b.usage_count - a.usage_count || a.label.localeCompare(b.label));
    return {
      total: elements.length,
      usageTotal: elements.reduce((sum, element) => sum + element.usage_count, 0),
      reviewCount: elements.filter((element) => element.stability === "review_needed").length,
      brokenCount: elements.filter((element) => element.stability === "broken").length,
      priority: unstableElements.slice(0, 3),
    };
  }, [elements]);

  useEffect(() => {
    if (isCreating) return;
    if (elements.length === 0 && elementsQuery.isFetching) return;
    const nextSelectedElementId = selectedElement?.element_id ?? null;
    if (selectedElementId !== nextSelectedElementId) setSelectedElementId(nextSelectedElementId);
  }, [elements.length, elementsQuery.isFetching, isCreating, selectedElement, selectedElementId]);

  useEffect(() => {
    setProbeResult(null);
  }, [isCreating, selectedElementId, selectedSiteId]);

  useEffect(() => {
    setBulkProbe(null);
  }, [search, selectedSiteId, stability]);

  useEffect(() => {
    if (selectedElement === null) {
      setForm(EMPTY_FORM);
      return;
    }
    setForm({
      element_key: selectedElement.element_key,
      label: selectedElement.label,
      selector: selectedElement.selector,
      element_type: selectedElement.element_type,
      stability: selectedElement.stability,
      source: selectedElement.source,
      sample_url: selectedElement.sample_url ?? "",
      notes: selectedElement.notes ?? "",
    });
  }, [selectedElement]);

  const invalidate = (): void => {
    setElementCursor(null);
    setNextElementCursor(null);
    setLoadedElements([]);
    void qc.invalidateQueries({ queryKey: ["site-elements"] });
  };

  const createMutation = useMutation({
    mutationFn: () => api.createSiteElement(selectedSiteId, cleanCreateBody(form), crypto.randomUUID()),
    onSuccess: (created) => {
      setIsCreating(false);
      setSelectedElementId(created.element_id);
      setMessage({ tone: "green", text: "화면 요소를 등록했습니다." });
      invalidate();
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
  });

  const updateMutation = useMutation({
    mutationFn: (item: SiteElementItem) =>
      api.updateSiteElement(selectedSiteId, item.element_id, cleanUpdateBody(form), crypto.randomUUID()),
    onSuccess: (updated) => {
      setSelectedElementId(updated.element_id);
      setMessage({ tone: "green", text: "화면 요소를 수정했습니다." });
      invalidate();
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
  });

  const deleteMutation = useMutation({
    mutationFn: (item: SiteElementItem) => api.deleteSiteElement(selectedSiteId, item.element_id, crypto.randomUUID()),
    onSuccess: () => {
      setIsCreating(false);
      setSelectedElementId(null);
      setMessage({ tone: "green", text: "화면 요소를 삭제했습니다." });
      invalidate();
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
  });

  const probeMutation = useMutation({
    mutationFn: (item: SiteElementItem) =>
      api.probeSiteElement(
        selectedSiteId,
        item.element_id,
        form.sample_url?.trim() ? { sample_url: form.sample_url.trim() } : {},
        crypto.randomUUID(),
      ),
    onSuccess: (result) => {
      setProbeResult(result);
      setMessage({
        tone: probeMessageTone(result.probe_status),
        text: result.probe_status === "matched" ? "찾기 검증이 완료되었습니다." : `찾기 검증 결과: ${probeReasonLabel(result)}`,
      });
      setForm({
        element_key: result.element.element_key,
        label: result.element.label,
        selector: result.element.selector,
        element_type: result.element.element_type,
        stability: result.element.stability,
        source: result.element.source,
        sample_url: result.element.sample_url ?? "",
        notes: result.element.notes ?? "",
      });
      invalidate();
    },
    onError: (error) => setMessage({ tone: "red", text: errorLabel(error) }),
  });

  const runBulkProbe = async (): Promise<void> => {
    if (selectedSiteId === "" || elements.length === 0 || bulkProbe?.running === true) return;

    let checked = 0;
    let matched = 0;
    let attention = 0;
    let failed = 0;
    let results: BulkProbeItem[] = [];
    setBulkProbe({ running: true, total: elements.length, checked, matched, attention, failed, results });

    for (const element of elements) {
      try {
        const result = await api.probeSiteElement(
          selectedSiteId,
          element.element_id,
          element.sample_url === null ? {} : { sample_url: element.sample_url },
          crypto.randomUUID(),
        );
        checked += 1;
        if (result.probe_status === "matched") matched += 1;
        else if (result.probe_status === "failed") failed += 1;
        else attention += 1;
        results = [...results, { label: element.label, status: result.probe_status, reason: probeReasonLabel(result) }];
      } catch (error) {
        checked += 1;
        failed += 1;
        results = [...results, { label: element.label, status: "failed", reason: errorLabel(error) }];
      }
      setBulkProbe({ running: true, total: elements.length, checked, matched, attention, failed, results });
    }

    setBulkProbe({ running: false, total: elements.length, checked, matched, attention, failed, results });
    setMessage({
      tone: failed > 0 ? "red" : attention > 0 ? "amber" : "green",
      text: `현재 목록 ${formatCount(elements.length)}건 재검증 완료 · 검증됨 ${formatCount(matched)}건`,
    });
    invalidate();
  };

  const formValid = selectedSiteId !== "" && form.element_key.trim() !== "" && form.label.trim() !== "" && form.selector.trim() !== "";

  return (
    <div className="object-repo-view">
      <section className="panel object-repo-toolbar" aria-label="화면 요소 저장소 필터">
        <div>
          <h2>사이트별 화면 요소 저장소</h2>
          <p className="subtle">브라우저 화면 요소를 업무 식별명과 화면에서 찾는 조건으로 관리해 여러 자동화가 같은 버튼과 필드를 재사용합니다.</p>
        </div>
        <div className="inline-actions">
          <label className="select-compact">
            <span>사이트</span>
            <select value={selectedSiteId} onChange={(event) => { resetElementList(); setSelectedSiteId(event.target.value); setSelectedElementId(null); setIsCreating(false); }}>
              {sites.map((site) => (
                <option key={site.site_profile_id} value={site.site_profile_id}>{site.name ?? "사이트명 미정"}</option>
              ))}
            </select>
            {hasMoreSites && <small className="subtle">사이트 100건 기준</small>}
          </label>
          {hasMoreSites && (
            <button className="btn" type="button" disabled={sitesQuery.isFetching} onClick={() => setSiteCursor(nextSiteCursor)}>
              {sitesQuery.isFetching && siteCursor !== null ? "불러오는 중" : "사이트 더 보기"}
            </button>
          )}
          <label className="select-compact">
            <span>상태</span>
            <select value={stability} onChange={(event) => { resetElementList(); setStability(event.target.value as "all" | SiteElementStability); }}>
              <option value="all">전체</option>
              {STABILITIES.map((value) => <option key={value} value={value}>{STABILITY_LABEL[value]}</option>)}
            </select>
          </label>
          <label className="repo-search">
            <span className="subtle">검색</span>
            <input value={search} onChange={(event) => { resetElementList(); setSearch(event.target.value); }} placeholder="이름, 업무 식별명, 화면 조건" />
          </label>
          <button className="btn" type="button" onClick={() => void elementsQuery.refetch()} disabled={selectedSiteId === ""}>
            새로고침
          </button>
        </div>
      </section>

      {sitesQuery.isLoading ? (
        <Loading />
      ) : sitesQuery.isError ? (
        <ErrorState message="사이트 목록을 불러오지 못했습니다." onRetry={() => void sitesQuery.refetch()} />
      ) : sites.length === 0 ? (
        <section className="panel"><p className="empty-state">등록된 사이트가 없습니다.</p></section>
      ) : (
        <div className="object-repo-layout">
          <section className="panel" aria-label="화면 요소 목록">
            <div className="panel-head">
              <h2>요소 목록</h2>
              <span className="badge blue">{selectedSite?.name ?? selectedSiteId}</span>
              {hasMoreElements && (
                <span className="badge amber">현재 100건 기준</span>
              )}
            </div>
            {elements.length > 0 && (
              <RepositorySummary
                total={summary.total}
                usageTotal={summary.usageTotal}
                reviewCount={summary.reviewCount}
                brokenCount={summary.brokenCount}
                hasMore={hasMoreElements}
                priority={summary.priority}
                bulkProbe={bulkProbe}
                bulkDisabled={selectedSiteId === "" || elements.length === 0 || can("site.update") === false}
                onBulkProbe={() => void runBulkProbe()}
                onSelect={(elementId) => {
                  setIsCreating(false);
                  setSelectedElementId(elementId);
                }}
              />
            )}
            {elementsQuery.isLoading ? (
              <Loading />
            ) : elementsQuery.isError ? (
              <ErrorState message="화면 요소를 불러오지 못했습니다." onRetry={() => void elementsQuery.refetch()} />
            ) : elements.length === 0 ? (
              <p className="empty-state">조건에 맞는 화면 요소가 없습니다.</p>
            ) : (
              <div className="table-wrap">
                <table className="catalog-table">
                  <thead>
                    <tr>
                      <th scope="col">요소</th>
                      <th scope="col">화면 조건</th>
                      <th scope="col">상태</th>
                      <th scope="col">사용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {elements.map((element) => (
                      <tr key={element.element_id} className={element.element_id === selectedElement?.element_id ? "selected-row" : undefined}>
                        <th scope="row">
                          <button className="linklike" type="button" onClick={() => { setIsCreating(false); setSelectedElementId(element.element_id); }}>
                            {element.label}
                          </button>
                          <span className="subtle" title="자동화에서 재사용할 업무 식별명이 등록되어 있습니다.">업무 식별명 등록됨</span>
                        </th>
                        <td><span className="subtle" title="화면에서 찾는 조건이 저장되어 있습니다.">조건 저장됨</span></td>
                        <td>
                          <span className={`badge ${stabilityTone(element.stability)}`}>{STABILITY_LABEL[element.stability]}</span>
                          <span className="badge muted">{TYPE_LABEL[element.element_type]}</span>
                        </td>
                        <td>{element.usage_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {hasMoreElements && (
                  <div className="list-pager">
                    <button className="btn" type="button" disabled={isFetchingMoreElements} onClick={() => setElementCursor(nextElementCursor)}>
                      {isFetchingMoreElements ? "불러오는 중" : "더 보기"}
                    </button>
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="panel object-repo-detail" aria-label="화면 요소 상세">
            <div className="panel-head">
              <h2>{selectedElement === null ? "새 요소" : "요소 상세"}</h2>
              {message !== null && <span className={`badge ${message.tone}`} role={message.tone === "red" ? "alert" : "status"}>{message.text}</span>}
            </div>
            <ElementForm form={form} setForm={setForm} lockKey={selectedElement !== null} />
            {probeResult !== null && (
              <div className="object-probe-result" role="status">
                <span className={`badge ${probeTone(probeResult.probe_status)}`}>{PROBE_LABEL[probeResult.probe_status]}</span>
                <strong>{probeMatchLabel(probeResult)}</strong>
                <span className="subtle">{probeResult.reason_code === null ? "화면 조건 확인됨" : probeReasonLabel(probeResult)}</span>
              </div>
            )}
            <div className="object-repo-actions">
              {can("site.update") && (
                <>
                  <button className="btn primary" type="button" disabled={!formValid || createMutation.isPending || selectedElement !== null} onClick={() => createMutation.mutate()}>
                    등록
                  </button>
                  <button className="btn" type="button" disabled={!formValid || updateMutation.isPending || selectedElement === null} onClick={() => selectedElement !== null && updateMutation.mutate(selectedElement)}>
                    수정 저장
                  </button>
                  <button className="btn" type="button" disabled={!formValid || probeMutation.isPending || selectedElement === null} onClick={() => selectedElement !== null && probeMutation.mutate(selectedElement)}>
                    찾기 검증
                  </button>
                  <button
                    className="btn danger"
                    type="button"
                    disabled={deleteMutation.isPending || selectedElement === null}
                    onClick={() => selectedElement !== null && window.confirm(`${selectedElement.label} 화면 요소를 삭제할까요?`) && deleteMutation.mutate(selectedElement)}
                  >
                    삭제
                  </button>
                </>
              )}
                <button className="btn" type="button" onClick={() => { setSelectedElementId(null); setIsCreating(true); setForm(EMPTY_FORM); }}>
                새 요소 입력
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
