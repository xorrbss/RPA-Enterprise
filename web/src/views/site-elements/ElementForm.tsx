import type {
  SiteElementCreateBody,
  SiteElementStability,
  SiteElementType,
  SiteElementUpdateBody,
} from "../../api/types";
import { ELEMENT_TYPES, STABILITIES, STABILITY_LABEL, TYPE_LABEL } from "./helpers";

export function ElementForm({ form, setForm, lockKey }: {
  form: SiteElementCreateBody;
  setForm: (value: SiteElementCreateBody) => void;
  lockKey: boolean;
}): JSX.Element {
  const update = (patch: Partial<SiteElementCreateBody>): void => setForm({ ...form, ...patch });
  return (
    <div className="object-repo-form">
      <label>
        <span>업무 식별명</span>
        <input value={form.element_key} disabled={lockKey} onChange={(event) => update({ element_key: event.target.value })} placeholder="예: 제출버튼" />
      </label>
      <label>
        <span>이름</span>
        <input value={form.label} onChange={(event) => update({ label: event.target.value })} placeholder="제출 버튼" />
      </label>
      <label className="field-wide">
        <span>화면에서 찾는 조건</span>
        <input value={form.selector} onChange={(event) => update({ selector: event.target.value })} placeholder="예: 제출 버튼, 저장 버튼, 주문번호 입력칸" />
      </label>
      <label>
        <span>유형</span>
        <select value={form.element_type ?? "other"} onChange={(event) => update({ element_type: event.target.value as SiteElementType })}>
          {ELEMENT_TYPES.map((type) => <option key={type} value={type}>{TYPE_LABEL[type]}</option>)}
        </select>
      </label>
      <label>
        <span>상태</span>
        <select value={form.stability ?? "stable"} onChange={(event) => update({ stability: event.target.value as SiteElementStability })}>
          {STABILITIES.map((value) => <option key={value} value={value}>{STABILITY_LABEL[value]}</option>)}
        </select>
      </label>
      <label className="field-wide">
        <span>샘플 주소</span>
        <input value={form.sample_url ?? ""} onChange={(event) => update({ sample_url: event.target.value })} placeholder="https://portal.example.com/form" />
      </label>
      <label className="field-wide">
        <span>메모</span>
        <textarea value={form.notes ?? ""} onChange={(event) => update({ notes: event.target.value })} placeholder="공유되는 업무 흐름이나 주의사항" />
      </label>
    </div>
  );
}

export function cleanCreateBody(form: SiteElementCreateBody): SiteElementCreateBody {
  return {
    element_key: form.element_key.trim(),
    label: form.label.trim(),
    selector: form.selector.trim(),
    element_type: form.element_type,
    stability: form.stability,
    source: form.source ?? "manual",
    ...(form.sample_url?.trim() ? { sample_url: form.sample_url.trim() } : {}),
    ...(form.notes?.trim() ? { notes: form.notes.trim() } : {}),
  };
}

export function cleanUpdateBody(form: SiteElementCreateBody): SiteElementUpdateBody {
  return {
    label: form.label.trim(),
    selector: form.selector.trim(),
    element_type: form.element_type,
    stability: form.stability,
    ...(form.sample_url?.trim() ? { sample_url: form.sample_url.trim() } : { sample_url: null }),
    ...(form.notes?.trim() ? { notes: form.notes.trim() } : { notes: null }),
  };
}
