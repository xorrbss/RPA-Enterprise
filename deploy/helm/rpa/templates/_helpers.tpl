{{- define "rpa.name" -}}
rpa-enterprise
{{- end -}}

{{- define "rpa.namespace" -}}
{{- default .Release.Namespace .Values.namespaceOverride -}}
{{- end -}}

{{- define "rpa.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag }}
{{- end -}}

{{- define "rpa.labels" -}}
app.kubernetes.io/name: {{ include "rpa.name" . }}
app.kubernetes.io/part-of: rpa-enterprise
app.kubernetes.io/managed-by: Helm
{{- end -}}
