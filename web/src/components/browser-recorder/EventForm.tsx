import type { SiteElementItem } from "../../api/types";
import { EVENT_LABEL, EVENT_TYPES, repositoryMetaLabel, repositoryOptionLabel, type EventDraft } from "./helpers";

export function EventForm(props: {
  value: EventDraft;
  onChange: (next: EventDraft) => void;
  startUrl: string;
  repositoryElements: readonly SiteElementItem[];
  disabled: boolean;
}): JSX.Element {
  const update = (patch: Partial<EventDraft>): void =>
    props.onChange({ ...props.value, ...patch });
  const selectedRepositoryKey = props.repositoryElements.some(
    (item) => item.element_key === props.value.element_key,
  )
    ? props.value.element_key
    : "";
  const selectedRepositoryElement =
    props.repositoryElements.find((item) => item.element_key === selectedRepositoryKey) ?? null;
  const selectRepositoryElement = (elementKey: string): void => {
    const item = props.repositoryElements.find(
      (candidate) => candidate.element_key === elementKey,
    );
    if (item === undefined) {
      update({ element_key: "" });
      return;
    }
    update({
      element_key: item.element_key,
      selector: item.selector,
      label: item.label,
    });
  };
  return (
    <div className="browser-recorder-event-form">
      <label>
        <span>녹화 동작</span>
        <select
          disabled={props.disabled}
          value={props.value.event_type}
          onChange={(event) =>
            update({
              event_type: event.target.value as EventDraft["event_type"],
            })
          }
        >
          {EVENT_TYPES.map((type) => (
            <option key={type} value={type}>
              {EVENT_LABEL[type]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>저장된 화면 설명</span>
        <select
          disabled={
            props.disabled ||
            props.value.event_type === "navigate" ||
            props.repositoryElements.length === 0
          }
          value={selectedRepositoryKey}
          onChange={(event) => selectRepositoryElement(event.target.value)}
        >
          <option value="">{props.repositoryElements.length === 0 ? "저장된 화면 설명 없음" : "화면 설명 직접 입력"}</option>
          {props.repositoryElements.map((item) => (
            <option key={item.element_id} value={item.element_key}>
              {repositoryOptionLabel(item)}
            </option>
          ))}
        </select>
        {selectedRepositoryElement !== null ? (
          <small className="subtle">
            저장소에서 찾기 조건을 가져왔습니다. {repositoryMetaLabel(selectedRepositoryElement)}
          </small>
        ) : (
          <small className="subtle">저장소를 선택하면 화면에서 찾는 조건과 표시 이름을 자동으로 채웁니다.</small>
        )}
      </label>
      <label className="field-wide">
        <span>화면에서 찾는 조건</span>
        <input
          disabled={props.disabled || props.value.event_type === "navigate"}
          value={props.value.selector}
          onChange={(event) => update({ selector: event.target.value })}
          placeholder="예: 제출 버튼, 승인 확인 영역"
        />
      </label>
      <label>
        <span>표시 이름</span>
        <input
          disabled={props.disabled}
          value={props.value.label}
          onChange={(event) => update({ label: event.target.value })}
          placeholder="제출 버튼"
        />
      </label>
      <label>
        <span>이동 주소</span>
        <input
          disabled={props.disabled || props.value.event_type !== "navigate"}
          value={props.value.url}
          onChange={(event) => update({ url: event.target.value })}
          placeholder={props.startUrl || "https://portal.example.com"}
        />
      </label>
      <label className="field-wide">
        <span>입력값 일부 표시</span>
        <input
          disabled={props.disabled || props.value.event_type !== "input"}
          value={props.value.value_preview}
          onChange={(event) => update({ value_preview: event.target.value })}
          placeholder="마스킹된 예시만 입력하세요"
        />
      </label>
    </div>
  );
}
