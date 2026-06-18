import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { useApiClient } from "../api/context";
import { ErrorState, Loading } from "./states";

type MediaKind = "image" | "video";

interface ArtifactMediaPreviewProps {
  artifactId: string;
  mediaType: string | null | undefined;
  filename?: string | null;
}

function kindFromMediaType(mediaType: string | null | undefined): MediaKind | null {
  if (mediaType?.startsWith("image/")) return "image";
  if (mediaType?.startsWith("video/")) return "video";
  return null;
}

function extensionFromMediaType(mediaType: string | null | undefined): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/webp") return "webp";
  if (mediaType === "video/webm") return "webm";
  if (mediaType === "video/mp4") return "mp4";
  return "bin";
}

function fallbackFilename(artifactId: string, mediaType: string | null | undefined): string {
  return `artifact-${artifactId.slice(0, 8)}.${extensionFromMediaType(mediaType)}`;
}

function hasObjectUrlApi(): boolean {
  return typeof URL.createObjectURL === "function" && typeof URL.revokeObjectURL === "function";
}

export function ArtifactMediaPreview({
  artifactId,
  mediaType,
  filename,
}: ArtifactMediaPreviewProps): JSX.Element {
  const api = useApiClient();
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["artifact-blob", artifactId],
    queryFn: () => api.getArtifactBlob(artifactId),
    retry: false,
  });
  const kind = kindFromMediaType(mediaType ?? q.data?.type);
  const downloadName = filename ?? fallbackFilename(artifactId, mediaType ?? q.data?.type);

  useEffect(() => {
    if (q.data === undefined || !hasObjectUrlApi()) {
      setObjectUrl(null);
      return;
    }
    const url = URL.createObjectURL(q.data);
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [q.data]);

  function download(): void {
    if (q.data === undefined || !hasObjectUrlApi()) return;
    const url = URL.createObjectURL(q.data);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (q.isLoading) return <Loading />;
  if (q.isError) {
    return <ErrorState message="미디어 원본을 불러오지 못했습니다." onRetry={() => void q.refetch()} />;
  }

  return (
    <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
      {objectUrl !== null && kind === "image" && (
        <img
          src={objectUrl}
          alt={downloadName}
          style={{ maxWidth: "100%", maxHeight: 360, objectFit: "contain", border: "1px solid var(--line)", borderRadius: 6 }}
        />
      )}
      {objectUrl !== null && kind === "video" && (
        <video
          src={objectUrl}
          controls
          aria-label={downloadName}
          style={{ maxWidth: "100%", maxHeight: 360, border: "1px solid var(--line)", borderRadius: 6 }}
        />
      )}
      {objectUrl === null && q.data !== undefined && (
        <p className="subtle" style={{ margin: 0 }}>미디어 원본을 불러왔지만 현재 브라우저에서 미리보기 URL을 만들 수 없습니다.</p>
      )}
      <div>
        <button className="btn" type="button" disabled={q.data === undefined || !hasObjectUrlApi()} onClick={download}>
          원본 다운로드
        </button>
      </div>
    </div>
  );
}
